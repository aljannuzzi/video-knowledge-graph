import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SceneMetadata, Timecode, VideoAsset } from "@vkg/shared";
import {
  isConflict, PermanentError, type JobContext, type JobRecord, type SceneRecord, type Services
} from "./contracts.js";
import * as media from "./media.js";

type EmbeddingText = (scene: SceneMetadata) => string;
type Source = { video: VideoAsset; path: string; durationSeconds: number; fps: number };
export interface PipelineOptions {
  media?: Pick<typeof media, "probeMedia" | "captureFrame" | "extractClip" | "zipFiles">;
  workRoot?: string;
  evidenceContainer?: string;
  exportContainer?: string;
}

export function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new PermanentError(`Invalid ${label}`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PermanentError("Expected an object");
  return value as Record<string, unknown>;
}

export function validateTimecode(value: unknown, duration: number, sceneBounds?: Timecode): Timecode {
  const timecode = record(value);
  const start = timecode.startSeconds;
  const end = timecode.endSeconds;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) ||
      !Number.isFinite(end) || start < 0 || end <= start || end > duration ||
      (sceneBounds && (start < sceneBounds.startSeconds || end > sceneBounds.endSeconds))) {
    throw new PermanentError("Clip or scene timecode is outside the canonical source bounds");
  }
  return { startSeconds: start, endSeconds: end };
}

function validateEmbedding(embedding: number[]): void {
  if (!Array.isArray(embedding) || embedding.length !== 1536 ||
      embedding.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new PermanentError("Embedding must contain exactly 1536 finite numbers");
  }
}

function assertEtag(scene: SceneRecord): void {
  if (!scene._etag) throw new Error("Store must return _etag for optimistic scene updates");
}

export function resolveWorkRoot(configured = process.env.WORKER_WORK_ROOT, home = homedir()): string {
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("WORKER_WORK_ROOT must not be empty");
    return resolve(configured);
  }
  if (typeof home === "string" && home.trim()) return resolve(home, ".work", "jobs");
  throw new Error("Worker work root is not configured");
}

// Never regenerate an existing scene's editorial metadata. Each embedding and
// graph projection belongs to a single ETag/version; conflicts reload canonical.
export async function indexScene(
  services: Services, videoId: string, sceneId: string, context: JobContext,
  embeddingText: EmbeddingText, expectedVersion?: string
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    context.assertOwned();
    const scene = await services.store.getScene(videoId, sceneId);
    if (!scene) throw new PermanentError("Scene no longer exists");
    if (expectedVersion !== undefined && scene.metadataVersion !== expectedVersion) return;
    if (scene.graphStatus === "ready") return;
    assertEtag(scene);
    await context.progress("embedding", 65);
    const embedding = await services.ai.embed(embeddingText(scene));
    validateEmbedding(embedding);
    context.assertOwned();
    let pending: SceneRecord;
    try {
      pending = await services.store.saveScene({
        ...scene, embedding, graphStatus: "pending", updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (isConflict(error)) continue;
      throw error;
    }
    assertEtag(pending);
    context.assertOwned();
    await context.progress("graph-projecting", 80);
    // project() must verify the active metadata version as part of its native
    // idempotent Gremlin projection. The ETag below also fences the ready flag.
    try {
      await services.graph.project(pending);
    } catch (error) {
      context.assertOwned();
      if (isConflict(error)) {
        const latest = await services.store.getScene(videoId, sceneId);
        if (latest && latest.metadataVersion !== pending.metadataVersion) {
          if (expectedVersion !== undefined) return;
          continue;
        }
      }
      try {
        await services.store.saveScene({
          ...pending, graphStatus: "failed", updatedAt: new Date().toISOString()
        });
      } catch (saveError) {
        if (!isConflict(saveError)) throw saveError;
      }
      throw error;
    }
    context.assertOwned();
    try {
      await services.store.saveScene({
        ...pending, graphStatus: "ready", updatedAt: new Date().toISOString()
      });
      return;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw Object.assign(new Error("Scene changed repeatedly during indexing"), { statusCode: 412 });
}

export async function executeJob(
  services: Services, job: JobRecord, context: JobContext,
  embeddingText: EmbeddingText, options: PipelineOptions = {}
): Promise<{ outputUri?: string }> {
  context.assertOwned();
  const jobId = validateId(job.id, "job ID");
  const workRoot = options.workRoot ?? resolveWorkRoot();
  const jobRoot = join(workRoot, jobId);
  // A stale worker may finish cleanup after another owner claims the same job.
  // Each claim therefore owns a separate subdirectory, never the entire job root.
  const work = join(jobRoot, randomUUID());
  const tools = options.media ?? media;
  const evidenceContainer = options.evidenceContainer ?? process.env.WORKER_EVIDENCE_CONTAINER ?? "evidence";
  const exportContainer = options.exportContainer ?? process.env.WORKER_EXPORT_CONTAINER ?? "exports";
  const sources = new Map<string, Source>();
  const source = async (videoId: string): Promise<Source> => {
    validateId(videoId, "video ID");
    const cached = sources.get(videoId);
    if (cached) return cached;
    context.assertOwned();
    const video = await services.store.getVideo(videoId);
    if (!video || video.id !== videoId || !video.assetUri) throw new PermanentError("Canonical video source not found");
    const path = join(work, `source-${sources.size}`);
    // Never consume a URI from the job payload.
    const blob = services.blobs.blobNameFromUri(video.assetUri);
    context.assertOwned();
    await services.blobs.downloadFile(blob.container, blob.name, path);
    context.assertOwned();
    let probe: Awaited<ReturnType<typeof media.probeMedia>>;
    try {
      probe = await tools.probeMedia(path, context.signal);
    } catch (error) {
      context.assertOwned();
      if (error instanceof TypeError || error instanceof RangeError ||
          (error instanceof Error && error.message.startsWith("ffprobe failed"))) {
        throw new PermanentError("Invalid, unsupported, non-video, or oversized media", { cause: error });
      }
      throw error;
    }
    const maximum = Math.min(180, services.config.maxVideoSeconds);
    if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("Invalid maxVideoSeconds configuration");
    if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0 ||
        probe.durationSeconds > maximum || !Number.isFinite(probe.fps) || probe.fps <= 0) {
      throw new PermanentError("Invalid video duration or frame rate");
    }
    const result = { video, path, ...probe };
    sources.set(videoId, result);
    return result;
  };

  await mkdir(work, { recursive: true });
  try {
    if (job.kind === "reindex") {
      const payload = record(job.payload);
      const videoId = validateId(payload.videoId, "video ID");
      const sceneId = validateId(payload.sceneId, "scene ID");
      if (typeof payload.metadataVersion !== "string" || !payload.metadataVersion ||
          (job.videoId !== undefined && job.videoId !== videoId)) {
        throw new PermanentError("Invalid reindex version or video ID");
      }
      await indexScene(services, videoId, sceneId, context, embeddingText, payload.metadataVersion);
      const video = await services.store.getVideo(videoId);
      if (video?.status === "failed") {
        const scenes = await services.store.listScenes(videoId);
        context.assertOwned();
        // A previous indexing attempt may have failed the video. Restore it
        // only once ingestion is complete and every current scene is ready.
        if (video.sceneCount > 0 && scenes.length === video.sceneCount &&
            scenes.every(scene => scene.graphStatus === "ready")) {
          await services.store.saveVideo({ ...video, status: "ready" });
          context.assertOwned();
        }
      }
      return {};
    }
    if (job.kind === "ingest") {
      const videoId = validateId(job.videoId, "video ID");
      await context.progress("validating-source", 5);
      const input = await source(videoId);
      context.assertOwned();
      await services.store.saveVideo({
        ...input.video, status: "processing", durationSeconds: input.durationSeconds, fps: input.fps
      });
      const windows = media.sceneWindows(input.durationSeconds);
      for (const [index, window] of windows.entries()) {
        context.assertOwned();
        await context.progress(`scene:${window.id}:sampling`, 10 + Math.floor(index / windows.length * 75));
        const existing = await services.store.getScene(videoId, window.id);
        if (!existing) {
          const frames: Array<{ seconds: number; dataUrl: string }> = [];
          const evidenceFrames: SceneMetadata["evidenceFrames"] = [];
          for (const [frameIndex, seconds] of window.frameSeconds.entries()) {
            context.assertOwned();
            const path = join(work, `${window.id}-${frameIndex}.jpg`);
            await tools.captureFrame(input.path, seconds, path, context.signal);
            context.assertOwned();
            const data = await readFile(path);
            if (!data.length) throw new PermanentError("Frame extraction produced an empty image");
            frames.push({ seconds, dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` });
            const uri = await services.blobs.uploadFile(
              evidenceContainer, `${videoId}/${window.id}/v1/frame-${frameIndex}.jpg`, path, "image/jpeg"
            );
            context.assertOwned();
            evidenceFrames.push({ seconds, uri });
          }
          await context.progress(`scene:${window.id}:vision`, 25 + Math.floor(index / windows.length * 50));
          const analysis = await services.ai.analyzeFrames(frames, window.timecode);
          context.assertOwned();
          const scene: SceneRecord = {
            kind: "scene", id: window.id, videoId, videoTitle: input.video.title,
            assetUri: input.video.assetUri, thumbnailUri: evidenceFrames[0].uri,
            timecode: window.timecode, transcript: "", caption: analysis.caption,
            entities: analysis.entities, relations: analysis.relations, tags: analysis.tags,
            embedding: [], evidenceFrames, model: services.config.visionDeployment,
            metadataVersion: "1", boundarySource: "model-estimate", graphStatus: "pending",
            updatedAt: new Date().toISOString(),
            provenance: {
              modality: "visual-only", transcriptAvailable: false,
              boundaryMethod: "fixed-12-second-sampling-windows", cutDetection: false,
              sampleIntervalSeconds: 2, maxFramesPerWindow: 6,
              visionDeployment: services.config.visionDeployment,
              embeddingDeployment: services.config.embeddingDeployment,
              sourceDurationSeconds: input.durationSeconds, sourceFps: input.fps
            }
          };
          await context.progress("embedding", 65);
          scene.embedding = await services.ai.embed(embeddingText(scene));
          validateEmbedding(scene.embedding);
          context.assertOwned();
          // Recheck after expensive model calls; do not replace a scene created
          // or edited while this worker was awaiting a remote response.
          if (!await services.store.getScene(videoId, window.id)) {
            context.assertOwned();
            try { await services.store.saveScene(scene); }
            catch (error) { if (!isConflict(error)) throw error; }
          }
        }
        await indexScene(services, videoId, window.id, context, embeddingText);
      }
      await context.progress("finalizing-video", 95);
      const current = await services.store.getVideo(videoId);
      const scenes = await services.store.listScenes(videoId);
      context.assertOwned();
      if (!current) throw new PermanentError("Video disappeared during ingestion");
      const ready = windows.every(window => scenes.some(scene => scene.id === window.id && scene.graphStatus === "ready"));
      if (!ready) throw Object.assign(new Error("Scene versions still awaiting projection"), { statusCode: 409 });
      await services.store.saveVideo({
        ...current, status: "ready", durationSeconds: input.durationSeconds, fps: input.fps, sceneCount: scenes.length
      });
      context.assertOwned();
      return {};
    }
    if (job.kind !== "export") throw new PermanentError("Unsupported job kind");
    const payload = record(job.payload);
    if (!Array.isArray(payload.clips) || payload.clips.length === 0 || payload.clips.length > 30) {
      throw new PermanentError("Export requires between 1 and 30 clips");
    }
    const files: Array<{ path: string; name: string }> = [];
    const manifest: Array<Record<string, unknown>> = [];
    for (const [index, value] of payload.clips.entries()) {
      context.assertOwned();
      await context.progress(`export:${index + 1}:validating`, Math.floor(index / payload.clips.length * 85));
      const clip = record(value);
      const videoId = validateId(clip.videoId, "video ID");
      const sceneId = validateId(clip.sceneId, "scene ID");
      const scene = await services.store.getScene(videoId, sceneId);
      if (!scene || scene.videoId !== videoId || scene.id !== sceneId) throw new PermanentError("Export scene not found");
      const input = await source(videoId);
      const sceneBounds = validateTimecode(scene.timecode, input.durationSeconds);
      const timecode = validateTimecode(clip.timecode, input.durationSeconds, sceneBounds);
      const name = `clip-${String(index + 1).padStart(4, "0")}.mp4`;
      const path = join(work, name);
      await context.progress(`export:${index + 1}:encoding`, Math.floor(index / payload.clips.length * 85) + 5);
      await tools.extractClip(input.path, timecode, path, context.signal);
      context.assertOwned();
      files.push({ path, name });
      manifest.push({
        file: name, videoId, sceneId, sourceUri: input.video.assetUri,
        sourceFilename: input.video.filename, sourceDurationSeconds: input.durationSeconds, sourceFps: input.fps,
        timecode, durationSeconds: timecode.endSeconds - timecode.startSeconds,
        sceneTimecode: sceneBounds, metadataVersion: scene.metadataVersion,
        model: scene.model, evidenceFrames: scene.evidenceFrames,
        caption: scene.caption, entities: scene.entities, relations: scene.relations, tags: scene.tags,
        transcript: "", provenance: { ...scene.provenance, modality: "visual-only" },
        boundarySource: scene.boundarySource
      });
    }
    await context.progress("export:packaging", 90);
    const manifestPath = join(work, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1, jobId, generatedAt: new Date().toISOString(),
      timebase: "absolute source seconds", clips: manifest
    }, null, 2), "utf8");
    files.push({ path: manifestPath, name: "manifest.json" });
    const zipPath = join(work, "clips.zip");
    await tools.zipFiles(files, zipPath, context.signal);
    context.assertOwned();
    await context.progress("export:uploading", 95);
    // Fixed-path exports require create-if-absent semantics in the blob adapter
    // (see contracts.ts); ownership checks alone cannot cancel an in-flight PUT.
    const outputUri = await services.blobs.uploadFile(exportContainer, `${jobId}/clips.zip`, zipPath, "application/zip");
    context.assertOwned();
    return { outputUri };
  } finally {
    await rm(work, { recursive: true, force: true });
    // rmdir (not recursive rm) cannot remove another lease owner's workspace.
    await rmdir(jobRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
  }
}
