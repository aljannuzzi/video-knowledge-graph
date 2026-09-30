import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SceneMetadata, Timecode, VideoAsset } from "@vkg/shared";
import {
  isTransient, LeaseLostError, PermanentError, type JobContext, type JobRecord,
  type SceneRecord, type Services
} from "./contracts.js";
import { executeJob, resolveWorkRoot, type PipelineOptions } from "./pipeline.js";

const timestamp = "2026-09-30T12:00:00.000Z";
const canonicalUri = "https://storage.example.test/videos/canonical.mp4";
const outputUri = "https://storage.example.test/actual-output/returned-archive.zip";
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".work", "tests");
const vector = () => Array.from({ length: 1536 }, (_, index) => (index + 1) / 1536);
const copy = <T>(value: T): T => structuredClone(value);
const conflict = () => Object.assign(new Error("Stale scene ETag"), { statusCode: 412 });

function scene(overrides: Partial<SceneRecord> = {}): SceneRecord {
  return {
    kind: "scene", id: "scene-0001", videoId: "video-1", videoTitle: "Canonical video",
    assetUri: canonicalUri, thumbnailUri: "https://storage.example.test/evidence/first.jpg",
    timecode: { startSeconds: 0, endSeconds: 12 }, transcript: "",
    caption: "Editor: a person carries a red bag.",
    entities: [
      { id: "person-1", type: "person", name: "Person", confidence: 0.95, actorName: "Alex", identitySource: "editor" },
      { id: "bag-1", type: "object", name: "Red bag", confidence: 0.9 }
    ],
    relations: [{
      id: "relation-1", subject: "person-1", predicate: "carries", object: "bag-1",
      confidence: 0.9, timecode: { startSeconds: 3, endSeconds: 5 }, evidence: "Visible in source frame at 4s"
    }],
    tags: ["editor-approved", "red-bag"], embedding: Array(1536).fill(-1),
    evidenceFrames: [
      { seconds: 2, uri: "https://storage.example.test/evidence/first.jpg" },
      { seconds: 4, uri: "https://storage.example.test/evidence/second.jpg" }
    ],
    model: "vision-original", metadataVersion: "editor-v2", boundarySource: "editor",
    graphStatus: "pending", updatedAt: timestamp, _etag: '"seed"',
    provenance: { modality: "visual-only", transcriptAvailable: false, editorReviewed: true },
    ...overrides
  };
}

function job(kind: JobRecord["kind"] = "ingest", payload: unknown = {}): JobRecord {
  return {
    id: "job-1", kind, videoId: "video-1", status: "running", stage: "starting",
    progress: 0, createdAt: timestamp, updatedAt: timestamp, attempts: 1,
    nextDispatchAt: timestamp, payload
  };
}

function reindexJob(metadataVersion = "editor-v2"): JobRecord {
  return job("reindex", { videoId: "video-1", sceneId: "scene-0001", metadataVersion });
}

function exportJob(timecodes: Timecode[] = [{ startSeconds: 3.125, endSeconds: 5.875 }]): JobRecord {
  return job("export", {
    assetUri: "https://attacker.example.test/top-level.mp4",
    clips: timecodes.map(timecode => ({
      videoId: "video-1", sceneId: "scene-0001", timecode,
      assetUri: "file:///C:/private/payload.mp4", sourceUri: "https://attacker.example.test/clip.mp4"
    }))
  });
}

function fixture(workRoot: string) {
  const scenes = new Map<string, SceneRecord>();
  const events: string[] = [];
  const saves: SceneRecord[] = [];
  const saveAttempts: SceneRecord[] = [];
  const videoSaves: VideoAsset[] = [];
  const projections: SceneRecord[] = [];
  const embeddingInputs: SceneMetadata[] = [];
  const embeddedTexts: string[] = [];
  const analyses: Array<{ frames: Array<{ seconds: number; dataUrl: string }>; timecode: Timecode }> = [];
  const captures: Array<{ source: string; seconds: number; path: string }> = [];
  const extractions: Array<{ source: string; timecode: Timecode; path: string }> = [];
  const downloads: Array<{ container: string; name: string; path: string }> = [];
  const uploads: Array<{ container: string; name: string; path: string; contentType: string; uri: string; bytes: Buffer }> = [];
  const archives: Array<Array<{ name: string; path: string; bytes: Buffer }>> = [];
  const parsedUris: string[] = [];
  const progress: Array<{ stage: string; value: number }> = [];
  const controller = new AbortController();
  const leaseError = new LeaseLostError("Test lease was lost");
  let owned = true;
  let etag = 0;
  let ownershipChecks = 0;
  const state = {
    probe: { durationSeconds: 25.25, fps: 29.97 },
    video: {
      id: "video-1", title: "Canonical video", filename: "canonical-original.mp4",
      status: "queued", createdAt: timestamp, sceneCount: 0, jobId: "job-1",
      assetUri: canonicalUri, durationSeconds: 999, fps: 1
    } as VideoAsset,
    embedding: vector(),
    afterRemote: (_event: string): void => {}
  };
  const remote = (event: string) => {
    events.push(event);
    state.afterRemote(event);
  };
  const checkPath = (path: string) => {
    const local = relative(workRoot, path);
    assert.ok(local && !local.startsWith("..") && !isAbsolute(local), `Unsafe test output: ${path}`);
  };
  const context: JobContext = {
    signal: controller.signal,
    assertOwned() {
      ownershipChecks++;
      if (!owned || controller.signal.aborted) throw leaseError;
    },
    async progress(stage, value) {
      context.assertOwned();
      progress.push({ stage, value });
    }
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected pipeline service call"); };
  const services: Services = {
    config: {
      environment: "test", port: 8080, authDisabled: true, appPassword: "",
      visionDeployment: "vision-test", embeddingDeployment: "embedding-test", maxVideoSeconds: 180
    },
    store: {
      async getVideo(id) {
        const result = id === state.video.id ? copy(state.video) : undefined;
        remote("getVideo");
        return result;
      },
      async saveVideo(value) {
        state.video = copy(value);
        videoSaves.push(copy(value));
        remote(`saveVideo:${value.status}`);
      },
      async getScene(videoId, id) {
        const value = scenes.get(id);
        const result = value?.videoId === videoId ? copy(value) : undefined;
        remote("getScene");
        return result;
      },
      async listScenes(videoId) {
        const result = [...scenes.values()].filter(value => value.videoId === videoId).map(copy);
        remote("listScenes");
        return result;
      },
      async saveScene(value) {
        saveAttempts.push(copy(value));
        const current = scenes.get(value.id);
        if ((current && current._etag !== value._etag) || (!current && value._etag)) {
          events.push(`conflict:${value.graphStatus}:${value.metadataVersion}`);
          throw conflict();
        }
        const saved = { ...copy(value), _etag: `"etag-${++etag}"` };
        scenes.set(saved.id, saved);
        saves.push(copy(saved));
        remote(`saveScene:${saved.graphStatus}`);
        return copy(saved);
      },
      getJob: unused, listJobs: unused, createJob: unused, saveJob: unused,
      claimJob: unused, renewJob: unused, updateOwnedJob: unused, recoverableJobs: unused
    },
    blobs: {
      blobNameFromUri(uri) {
        parsedUris.push(uri);
        if (uri !== canonicalUri) throw new PermanentError("Untrusted canonical blob URI");
        return { container: "videos", name: "canonical.mp4" };
      },
      async downloadFile(container, name, path) {
        checkPath(path);
        downloads.push({ container, name, path });
        await writeFile(path, "TEST ONLY: downloaded source bytes");
        remote("download");
      },
      async uploadFile(container, name, path, contentType) {
        checkPath(path);
        const bytes = await readFile(path);
        assert.ok(bytes.length);
        const uri = contentType === "application/zip"
          ? outputUri : `https://storage.example.test/actual-evidence/${uploads.length}.jpg`;
        uploads.push({ container, name, path, contentType, uri, bytes });
        remote(contentType === "application/zip" ? "upload:archive" : "upload:evidence");
        return uri;
      },
      delete: unused
    },
    queue: { client: {}, dispatch: unused, receive: unused, renew: unused, delete: unused },
    ai: {
      async analyzeFrames(frames, timecode) {
        analyses.push(copy({ frames, timecode }));
        const result = {
          caption: `Visible scene at source ${timecode.startSeconds}s`,
          entities: scene().entities,
          relations: scene().relations.map(relation => ({
            ...relation, timecode: copy(timecode), evidence: `Source frame at ${frames[0].seconds}s`
          })),
          tags: ["visual", `source-${timecode.startSeconds}`]
        };
        remote("analyze");
        return result;
      },
      async embed(text) {
        embeddedTexts.push(text);
        const result = copy(state.embedding);
        remote("embed");
        return result;
      }
    },
    graph: {
      async project(value) {
        projections.push(copy(value));
        remote("project");
      }
    }
  };
  // Deliberately fake file contents live only in this test fixture. The real
  // pipeline still performs its reads, manifest writes, uploads and cleanup.
  const media: NonNullable<PipelineOptions["media"]> = {
    async probeMedia(path, signal) {
      assert.equal(signal, controller.signal);
      assert.ok((await readFile(path)).length);
      const result = copy(state.probe);
      remote("probe");
      return result;
    },
    async captureFrame(source, seconds, path, signal) {
      assert.equal(signal, controller.signal);
      checkPath(path);
      captures.push({ source, seconds, path });
      await writeFile(path, `TEST ONLY: JPEG at source ${seconds}s`);
      remote("capture");
    },
    async extractClip(source, timecode, path, signal) {
      assert.equal(signal, controller.signal);
      checkPath(path);
      extractions.push({ source, timecode: copy(timecode), path });
      await writeFile(path, `TEST ONLY: MP4 from ${timecode.startSeconds} to ${timecode.endSeconds}`);
      remote("extract");
    },
    async zipFiles(files, path, signal) {
      assert.equal(signal, controller.signal);
      checkPath(path);
      const entries = await Promise.all(files.map(async file => {
        checkPath(file.path);
        return { ...file, bytes: await readFile(file.path) };
      }));
      archives.push(entries);
      await writeFile(path, "TEST ONLY: archive output, not a real ZIP");
      remote("zip");
    }
  };
  const embeddingText = (value: SceneMetadata) => {
    embeddingInputs.push(copy(value));
    return JSON.stringify({
      caption: value.caption, entities: value.entities, relations: value.relations,
      tags: value.tags, timecode: value.timecode
    });
  };
  const options: PipelineOptions = {
    workRoot, media, evidenceContainer: "test-evidence", exportContainer: "test-exports"
  };
  return {
    services, context, state, scenes, events, saves, saveAttempts, videoSaves, projections,
    embeddingInputs, embeddedTexts, analyses, captures, extractions, downloads, uploads,
    archives, parsedUris, progress, media, options, workRoot, leaseError,
    get ownershipChecks() { return ownershipChecks; },
    loseLease(abort = false) {
      owned = false;
      if (abort) controller.abort(leaseError);
    },
    seed(value = scene()) { scenes.set(value.id, copy(value)); },
    run(value = job()) { return executeJob(services, value, context, embeddingText, options); }
  };
}

type Fixture = ReturnType<typeof fixture>;

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "pipeline-"));
  try {
    await run(fixture(root));
  } finally {
    try {
      assert.deepEqual(await readdir(root), [], "Pipeline must remove its workspace, even on failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("resolveWorkRoot prefers explicit configuration and otherwise falls back to the user home directory", () => {
  assert.equal(resolveWorkRoot("worker-cache", "ignored-home"), resolve("worker-cache"));
  assert.equal(resolveWorkRoot(undefined, resolve("home", "node")), resolve("home", "node", ".work", "jobs"));
  assert.throws(() => resolveWorkRoot(" ", " "));
});

function edited(value: SceneRecord): SceneRecord {
  return {
    ...copy(value), caption: "Editor changed the caption while remote work was in flight",
    tags: ["new-editor-tag"], metadataVersion: "editor-v3", graphStatus: "pending",
    boundarySource: "editor", _etag: '"concurrent-editor"'
  };
}

test("ingest executes fixed-window visual-only analysis with source-absolute evidence and 1536-dimensional vectors", async () => {
  await withFixture(async f => {
    assert.deepEqual(await f.run(), {});
    const expectedTimes = [[0, 2, 4, 6, 8, 10], [12, 14, 16, 18, 20, 22], [24]];
    const expectedBounds = [
      { startSeconds: 0, endSeconds: 12 }, { startSeconds: 12, endSeconds: 24 },
      { startSeconds: 24, endSeconds: 25.25 }
    ];
    assert.equal(f.downloads.length, 1);
    assert.deepEqual(f.parsedUris, [canonicalUri]);
    assert.equal(f.events.filter(event => event === "probe").length, 1);
    assert.deepEqual(f.captures.map(frame => frame.seconds), expectedTimes.flat());
    assert.ok(f.captures.every(frame => frame.source === f.downloads[0].path));
    assert.equal(f.analyses.length, 3);
    assert.equal(f.projections.length, 3);
    assert.equal(f.scenes.size, 3);
    for (const [index, value] of [...f.scenes.values()].entries()) {
      assert.equal(value.id, `scene-${String(index + 1).padStart(4, "0")}`);
      assert.deepEqual(value.timecode, expectedBounds[index]);
      assert.deepEqual(f.analyses[index].timecode, expectedBounds[index]);
      assert.deepEqual(f.analyses[index].frames.map(frame => frame.seconds), expectedTimes[index]);
      for (const frame of f.analyses[index].frames) {
        assert.equal(frame.dataUrl, `data:image/jpeg;base64,${Buffer.from(`TEST ONLY: JPEG at source ${frame.seconds}s`).toString("base64")}`);
      }
      assert.deepEqual(value.evidenceFrames.map(frame => frame.seconds), expectedTimes[index]);
      for (const frame of value.evidenceFrames) {
        assert.ok(frame.seconds >= value.timecode.startSeconds && frame.seconds < value.timecode.endSeconds);
        const capture = f.captures.find(value => value.seconds === frame.seconds);
        assert.ok(capture);
        const upload = f.uploads.find(value => value.path === capture.path);
        assert.ok(upload);
        assert.equal(frame.uri, upload.uri);
        assert.equal(upload.name, `video-1/${value.id}/v1/frame-${expectedTimes[index].indexOf(frame.seconds)}.jpg`);
        assert.equal(upload.bytes.toString(), `TEST ONLY: JPEG at source ${frame.seconds}s`);
      }
      assert.equal(value.assetUri, canonicalUri);
      assert.equal(value.thumbnailUri, value.evidenceFrames[0].uri);
      assert.equal(value.transcript, "");
      assert.equal(value.caption, `Visible scene at source ${value.timecode.startSeconds}s`);
      assert.deepEqual(value.entities, scene().entities);
      assert.deepEqual(value.relations[0].timecode, expectedBounds[index]);
      assert.equal(value.model, "vision-test");
      assert.equal(value.metadataVersion, "1");
      assert.equal(value.boundarySource, "model-estimate");
      assert.deepEqual(value.provenance, {
        modality: "visual-only", transcriptAvailable: false,
        boundaryMethod: "fixed-12-second-sampling-windows", cutDetection: false,
        sampleIntervalSeconds: 2, maxFramesPerWindow: 6, visionDeployment: "vision-test",
        embeddingDeployment: "embedding-test", sourceDurationSeconds: 25.25, sourceFps: 29.97
      });
      assert.equal(value.graphStatus, "ready");
      assert.deepEqual(value.embedding, vector());
      const projected = f.projections[index];
      assert.equal(projected.graphStatus, "pending");
      assert.deepEqual(projected.embedding, vector());
      const writes = f.saves.filter(saved => saved.id === value.id);
      assert.equal(writes.at(-1)?.graphStatus, "ready");
      assert.equal(writes.at(-2)?._etag, projected._etag);
      assert.ok(writes.every(saved => saved.embedding.length === 1536));
    }
    const transitionEvents = f.events.filter(event => event === "project" || event.startsWith("saveScene:"));
    assert.equal(transitionEvents.filter(event => event === "saveScene:ready").length, 3);
    for (const [index, event] of transitionEvents.entries()) {
      if (event === "project") {
        assert.equal(transitionEvents[index - 1], "saveScene:pending");
        assert.equal(transitionEvents[index + 1], "saveScene:ready");
      }
    }
    assert.equal(f.uploads.length, 13);
    assert.ok(f.uploads.every(upload => upload.container === "test-evidence" && upload.contentType === "image/jpeg"));
    assert.deepEqual(f.videoSaves.map(video => video.status), ["processing", "ready"]);
    assert.equal(f.state.video.durationSeconds, 25.25);
    assert.equal(f.state.video.fps, 29.97);
    assert.equal(f.state.video.sceneCount, 3);
    assert.equal(f.ownershipChecks > 0, true);
  });
});

test("graph failure is recorded as failed, never ready, and the original error propagates", async () => {
  await withFixture(async f => {
    const failure = new Error("Graph is unavailable");
    f.state.afterRemote = event => { if (event === "project") throw failure; };
    await assert.rejects(f.run(), error => error === failure);
    assert.equal(f.scenes.get("scene-0001")?.graphStatus, "failed");
    assert.equal(f.saves.at(-1)?.graphStatus, "failed");
    assert.deepEqual(f.saves.at(-1)?.embedding, vector());
    assert.equal(f.saves.some(value => value.graphStatus === "ready"), false);
    assert.deepEqual(f.videoSaves.map(value => value.status), ["processing"]);
    assert.deepEqual(f.events.filter(event => event === "project" || event === "saveScene:failed"), ["project", "saveScene:failed"]);
  });
});

test("ingest retry skips ready scenes and preserves all editor metadata without model calls", async () => {
  await withFixture(async f => {
    f.state.probe.durationSeconds = 12;
    const original = scene({ graphStatus: "ready" });
    f.seed(original);
    await f.run();
    await f.run();
    assert.deepEqual(f.scenes.get(original.id), original);
    assert.deepEqual(f.saves, []);
    assert.deepEqual(f.projections, []);
    assert.deepEqual(f.embeddedTexts, []);
    assert.deepEqual(f.analyses, []);
    assert.deepEqual(f.captures, []);
    assert.deepEqual(f.uploads, []);
    assert.equal(f.state.video.status, "ready");
  });
});

test("ingest retry indexes a failed scene without regenerating editor metadata or evidence", async () => {
  await withFixture(async f => {
    f.state.probe.durationSeconds = 12;
    const original = scene({ graphStatus: "failed" });
    f.seed(original);
    await f.run();
    assert.deepEqual(f.analyses, []);
    assert.deepEqual(f.captures, []);
    assert.equal(f.embeddedTexts.length, 1);
    const result = f.scenes.get(original.id)!;
    assert.deepEqual(result, {
      ...original, graphStatus: "ready", embedding: vector(), updatedAt: result.updatedAt, _etag: result._etag
    });
  });
});

test("ingest reloads a concurrent editor version after graph projection; stale ready is rejected", async () => {
  await withFixture(async f => {
    f.state.probe.durationSeconds = 12;
    f.seed();
    const newVersionVector = Array(1536).fill(0.5);
    f.state.afterRemote = event => {
      if (event === "project" && f.projections.length === 1) {
        f.seed(edited(f.scenes.get("scene-0001")!));
        f.state.embedding = newVersionVector;
      }
    };
    await f.run();
    assert.deepEqual(f.projections.map(value => value.metadataVersion), ["editor-v2", "editor-v3"]);
    assert.ok(f.events.includes("conflict:ready:editor-v2"));
    assert.deepEqual(f.saves.filter(value => value.graphStatus === "ready").map(value => value.metadataVersion), ["editor-v3"]);
    assert.equal(f.scenes.get("scene-0001")?.caption, "Editor changed the caption while remote work was in flight");
    assert.deepEqual(f.projections[0].embedding, vector());
    assert.deepEqual(f.projections[1].embedding, newVersionVector);
    assert.deepEqual(f.scenes.get("scene-0001")?.embedding, newVersionVector);
    assert.deepEqual(f.embeddingInputs.map(value => value.metadataVersion), ["editor-v2", "editor-v3"]);
    assert.deepEqual(JSON.parse(f.embeddedTexts[1]).tags, ["new-editor-tag"]);
    assert.equal(f.state.video.status, "ready");
  });
});

test("scene created during ingest analysis is not overwritten with generated metadata", async () => {
  await withFixture(async f => {
    f.state.probe.durationSeconds = 12;
    const editorScene = scene({ graphStatus: "ready" });
    f.state.afterRemote = event => { if (event === "analyze") f.seed(editorScene); };
    await f.run();
    assert.deepEqual(f.scenes.get(editorScene.id), editorScene);
    assert.deepEqual(f.saves, []);
    assert.deepEqual(f.projections, []);
  });
});

test("reindex skips a stale requested metadataVersion without embedding, projection or source download", async () => {
  await withFixture(async f => {
    const original = scene();
    f.seed(original);
    assert.deepEqual(await f.run(reindexJob("obsolete-version")), {});
    assert.deepEqual(f.scenes.get(original.id), original);
    assert.deepEqual(f.embeddedTexts, []);
    assert.deepEqual(f.projections, []);
    assert.deepEqual(f.saves, []);
    assert.deepEqual(f.downloads, []);
  });
});

test("reindex current metadata embeds editor changes and saves pending -> projects -> saves ready", async () => {
  await withFixture(async f => {
    const original = scene();
    f.seed(original);
    await f.run(reindexJob());
    assert.deepEqual(f.embeddingInputs, [original]);
    assert.deepEqual(JSON.parse(f.embeddedTexts[0]), {
      caption: original.caption, entities: original.entities, relations: original.relations,
      tags: original.tags, timecode: original.timecode
    });
    assert.deepEqual(f.events.filter(event => event === "project" || event.startsWith("saveScene:")),
      ["saveScene:pending", "project", "saveScene:ready"]);
    assert.deepEqual(f.projections[0], f.saves[0]);
    assert.notDeepEqual(f.projections[0].embedding, original.embedding);
    assert.deepEqual(f.projections[0].embedding, vector());
    assert.deepEqual(f.scenes.get(original.id)?.embedding, vector());
    assert.equal(f.scenes.get(original.id)?.metadataVersion, original.metadataVersion);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.analyses, []);
    assert.deepEqual(f.videoSaves, []);
  });
});

test("successful reindex restores a failed video only when every ingested scene is ready", async () => {
  await withFixture(async f => {
    f.seed();
    f.state.video.status = "failed";
    f.state.video.sceneCount = 1;
    await f.run(reindexJob());
    assert.equal(f.state.video.status, "ready");
    assert.equal(f.videoSaves.length, 1);
  });
});

for (const sceneCount of [0, 2]) {
  test(`reindex does not restore a video with incomplete ingestion (sceneCount ${sceneCount})`, async () => {
    await withFixture(async f => {
      f.seed();
      f.state.video.status = "failed";
      f.state.video.sceneCount = sceneCount;
      await f.run(reindexJob());
      assert.equal(f.state.video.status, "failed");
      assert.deepEqual(f.videoSaves, []);
    });
  });
}

test("reindex does not restore a video with another failed current scene", async () => {
  await withFixture(async f => {
    f.seed();
    f.seed(scene({ id: "scene-0002", graphStatus: "failed" }));
    f.state.video.status = "failed";
    f.state.video.sceneCount = 2;
    await f.run(reindexJob());
    assert.equal(f.state.video.status, "failed");
    assert.deepEqual(f.videoSaves, []);
  });
});

for (const phase of ["embed", "project"] as const) {
  test(`reindex version changed during ${phase} cannot save stale metadata or ready status`, async () => {
    await withFixture(async f => {
      f.seed();
      let canonical: SceneRecord | undefined;
      f.state.afterRemote = event => {
        if (event === phase && !canonical) {
          canonical = edited(f.scenes.get("scene-0001")!);
          f.seed(canonical);
        }
      };
      await f.run(reindexJob());
      assert.deepEqual(f.scenes.get("scene-0001"), canonical);
      assert.equal(f.embeddedTexts.length, 1);
      assert.equal(f.projections.length, phase === "project" ? 1 : 0);
      assert.equal(f.saves.some(value => value.graphStatus === "ready"), false);
      assert.ok(f.events.includes(`conflict:${phase === "embed" ? "pending" : "ready"}:editor-v2`));
    });
  });
}

test("graph failure cannot mark a concurrently edited version failed", async () => {
  await withFixture(async f => {
    f.seed();
    const failure = new Error("Projection failed after editor saved");
    let canonical: SceneRecord | undefined;
    f.state.afterRemote = event => {
      if (event === "project") {
        canonical = edited(f.scenes.get("scene-0001")!);
        f.seed(canonical);
        throw failure;
      }
    };
    await assert.rejects(f.run(reindexJob()), error => error === failure);
    assert.deepEqual(f.scenes.get("scene-0001"), canonical);
    assert.equal(f.saves.some(value => value.graphStatus === "failed"), false);
    assert.ok(f.events.includes("conflict:failed:editor-v2"));
  });
});

test("repeated optimistic conflicts terminate with 412 instead of publishing stale ready", async () => {
  await withFixture(async f => {
    f.state.probe.durationSeconds = 12;
    f.seed();
    f.state.afterRemote = event => {
      if (event === "project") {
        const value = edited(f.scenes.get("scene-0001")!);
        value._etag = `"concurrent-${f.projections.length}"`;
        value.metadataVersion = `editor-${f.projections.length + 3}`;
        f.seed(value);
      }
    };
    await assert.rejects(f.run(), (error: unknown) =>
      !!error && typeof error === "object" && "statusCode" in error && error.statusCode === 412);
    assert.equal(f.projections.length, 5);
    assert.equal(f.scenes.get("scene-0001")?.graphStatus, "pending");
    assert.equal(f.saves.some(value => value.graphStatus === "ready"), false);
    assert.equal(f.state.video.status, "processing");
  });
});

test("export uses canonical video, precise clip times and a faithful manifest with actual returned output URI", async () => {
  await withFixture(async f => {
    const original = scene({
      assetUri: "https://attacker.example.test/stale-scene.mp4", graphStatus: "ready",
      timecode: { startSeconds: 12, endSeconds: 24 },
      evidenceFrames: [
        { seconds: 14, uri: "https://storage.example.test/evidence/14.jpg" },
        { seconds: 16, uri: "https://storage.example.test/evidence/16.jpg" }
      ],
      relations: scene().relations.map(value => ({
        ...value, timecode: { startSeconds: 14, endSeconds: 16 }, evidence: "Visible in source frame at 14s"
      }))
    });
    f.seed(original);
    const timecodes = [
      { startSeconds: 13.125, endSeconds: 15.875 }, { startSeconds: 19.25, endSeconds: 22.5 }
    ];
    const result = await f.run(exportJob(timecodes));
    assert.deepEqual(result, { outputUri });
    assert.deepEqual(f.parsedUris, [canonicalUri]);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.downloads[0].container, "videos");
    assert.equal(f.downloads[0].name, "canonical.mp4");
    assert.equal(f.events.filter(event => event === "probe").length, 1);
    assert.deepEqual(f.extractions.map(value => value.timecode), timecodes);
    assert.ok(f.extractions.every(value => value.source === f.downloads[0].path));
    assert.equal(f.archives.length, 1);
    const entries = f.archives[0];
    assert.deepEqual(entries.map(entry => entry.name), ["clip-0001.mp4", "clip-0002.mp4", "manifest.json"]);
    assert.ok(entries.every(entry => basename(entry.path) === entry.name));
    assert.equal(entries.some(entry => /fcpxml|\.xml$/i.test(entry.name)), false);
    for (const [index, timecode] of timecodes.entries()) {
      assert.equal(entries[index].path, f.extractions[index].path);
      assert.equal(entries[index].bytes.toString(), `TEST ONLY: MP4 from ${timecode.startSeconds} to ${timecode.endSeconds}`);
    }
    const manifest = JSON.parse(entries[2].bytes.toString());
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.jobId, "job-1");
    assert.ok(Number.isFinite(Date.parse(manifest.generatedAt)));
    assert.equal(manifest.timebase, "absolute source seconds");
    assert.deepEqual(manifest.clips, timecodes.map((timecode, index) => ({
      file: `clip-${String(index + 1).padStart(4, "0")}.mp4`, videoId: original.videoId,
      sceneId: original.id, sourceUri: canonicalUri, sourceFilename: f.state.video.filename,
      sourceDurationSeconds: 25.25, sourceFps: 29.97, timecode,
      durationSeconds: timecode.endSeconds - timecode.startSeconds, sceneTimecode: original.timecode,
      metadataVersion: original.metadataVersion, model: original.model, evidenceFrames: original.evidenceFrames,
      caption: original.caption, entities: original.entities, relations: original.relations,
      tags: original.tags, transcript: "", provenance: original.provenance, boundarySource: original.boundarySource
    })));
    assert.equal(JSON.stringify(manifest).includes("attacker.example.test"), false);
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].container, "test-exports");
    assert.equal(f.uploads[0].name, "job-1/clips.zip");
    assert.equal(f.uploads[0].contentType, "application/zip");
    assert.equal(f.uploads[0].bytes.toString(), "TEST ONLY: archive output, not a real ZIP");
    assert.deepEqual(f.saves, []);
    assert.deepEqual(f.embeddedTexts, []);
  });
});

test("export uses WORKER_WORK_ROOT when no explicit work root is supplied", async () => {
  await withFixture(async f => {
    f.seed(scene({ graphStatus: "ready" }));
    const env = process.env.WORKER_WORK_ROOT;
    process.env.WORKER_WORK_ROOT = f.workRoot;
    try {
      const { workRoot: _ignored, ...options } = f.options;
      const result = await executeJob(f.services, exportJob(), f.context, () => "unused", options);
      assert.deepEqual(result, { outputUri });
      assert.equal(f.downloads.length, 1);
      assert.deepEqual(f.extractions.map(value => value.timecode), [{ startSeconds: 3.125, endSeconds: 5.875 }]);
      assert.equal(f.uploads[0].name, "job-1/clips.zip");
    } finally {
      if (env === undefined) delete process.env.WORKER_WORK_ROOT;
      else process.env.WORKER_WORK_ROOT = env;
    }
  });
});

test("export rejects an untrusted canonical URI instead of falling back to the job payload", async () => {
  await withFixture(async f => {
    f.seed();
    f.state.video.assetUri = "file:///C:/private/secret.mp4";
    await assert.rejects(f.run(exportJob()), PermanentError);
    assert.deepEqual(f.parsedUris, [f.state.video.assetUri]);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.extractions, []);
    assert.deepEqual(f.uploads, []);
  });
});

for (const kind of ["ingest", "export"] as const) {
  for (const [label, probe, maximum] of [
    ["over hard limit despite stored duration", { durationSeconds: 180.01, fps: 30 }, 300],
    ["over configured limit", { durationSeconds: 31, fps: 30 }, 30],
    ["zero duration", { durationSeconds: 0, fps: 30 }, 180],
    ["negative duration", { durationSeconds: -1, fps: 30 }, 180],
    ["nonfinite duration", { durationSeconds: Number.NaN, fps: 30 }, 180],
    ["infinite duration", { durationSeconds: Infinity, fps: 30 }, 180],
    ["zero fps", { durationSeconds: 12, fps: 0 }, 180],
    ["negative fps", { durationSeconds: 12, fps: -1 }, 180],
    ["nonfinite fps", { durationSeconds: 12, fps: Infinity }, 180]
  ] as const) {
    test(`${kind} rejects actual probe ${label}`, async () => {
      await withFixture(async f => {
        f.seed();
        f.state.video.durationSeconds = 12;
        f.state.probe = { ...probe };
        f.services.config.maxVideoSeconds = maximum;
        await assert.rejects(f.run(kind === "ingest" ? job() : exportJob()), PermanentError);
        assert.equal(f.downloads.length, 1);
        assert.deepEqual(f.captures, []);
        assert.deepEqual(f.extractions, []);
        assert.deepEqual(f.videoSaves, []);
        assert.deepEqual(f.uploads, []);
      });
    });
  }
}

for (const failure of [new TypeError("No video"), new RangeError("Oversized video"), new Error("ffprobe failed (1): invalid input")]) {
  test(`probe rejection is permanent: ${failure.message}`, async () => {
    await withFixture(async f => {
      f.seed();
      f.state.afterRemote = event => { if (event === "probe") throw failure; };
      await assert.rejects(f.run(exportJob()), error => error instanceof PermanentError && error.cause === failure);
      assert.deepEqual(f.extractions, []);
      assert.deepEqual(f.uploads, []);
    });
  });
}

for (const [label, bounds, clip, duration] of [
  ["clip before scene", { startSeconds: 4, endSeconds: 10 }, { startSeconds: 3, endSeconds: 6 }, 12],
  ["clip after scene", { startSeconds: 4, endSeconds: 10 }, { startSeconds: 5, endSeconds: 11 }, 12],
  ["scene beyond probed source", { startSeconds: 0, endSeconds: 20 }, { startSeconds: 2, endSeconds: 4 }, 12],
  ["clip beyond probed source", { startSeconds: 0, endSeconds: 12 }, { startSeconds: 2, endSeconds: 13 }, 12],
  ["negative start", { startSeconds: 0, endSeconds: 12 }, { startSeconds: -1, endSeconds: 4 }, 12],
  ["empty clip", { startSeconds: 0, endSeconds: 12 }, { startSeconds: 4, endSeconds: 4 }, 12],
  ["reversed clip", { startSeconds: 0, endSeconds: 12 }, { startSeconds: 5, endSeconds: 4 }, 12],
  ["NaN clip", { startSeconds: 0, endSeconds: 12 }, { startSeconds: NaN, endSeconds: 4 }, 12],
  ["infinite clip", { startSeconds: 0, endSeconds: 12 }, { startSeconds: 2, endSeconds: Infinity }, 12],
  ["invalid canonical scene", { startSeconds: 9, endSeconds: 4 }, { startSeconds: 2, endSeconds: 4 }, 12]
] as const) {
  test(`export rejects ${label} before extraction and upload`, async () => {
    await withFixture(async f => {
      f.seed(scene({ timecode: { ...bounds } }));
      f.state.probe.durationSeconds = duration;
      f.state.video.durationSeconds = 180;
      await assert.rejects(f.run(exportJob([{ ...clip }])), PermanentError);
      assert.deepEqual(f.extractions, []);
      assert.deepEqual(f.archives, []);
      assert.deepEqual(f.uploads, []);
    });
  });
}

test("export accepts exact fractional scene bounds at the actual source end", async () => {
  await withFixture(async f => {
    const bounds = { startSeconds: 24, endSeconds: 25.25 };
    f.seed(scene({
      timecode: bounds, relations: [],
      evidenceFrames: [{ seconds: 24, uri: "https://storage.example.test/evidence/24.jpg" }]
    }));
    await f.run(exportJob([bounds]));
    assert.deepEqual(f.extractions[0].timecode, bounds);
  });
});

for (const invalid of ["../escape", "..\\escape", "C:\\escape", "/absolute", ".", "..", "", "a/b", "a\\b", "a\0b", "a".repeat(129)]) {
  for (const location of ["job", "ingest-video", "reindex-video", "reindex-scene", "export-video", "export-scene"] as const) {
    test(`blocks invalid ${location} ID ${JSON.stringify(invalid)} before source access`, async () => {
      await withFixture(async f => {
        f.seed();
        let request = job();
        if (location === "job") request.id = invalid;
        if (location === "ingest-video") request.videoId = invalid;
        if (location.startsWith("reindex")) {
          request = reindexJob();
          request.payload[location === "reindex-video" ? "videoId" : "sceneId"] = invalid;
        }
        if (location.startsWith("export")) {
          request = exportJob();
          request.payload.clips[0][location === "export-video" ? "videoId" : "sceneId"] = invalid;
        }
        await assert.rejects(f.run(request), PermanentError);
        assert.deepEqual(f.parsedUris, []);
        assert.deepEqual(f.downloads, []);
        assert.deepEqual(f.saves, []);
        assert.deepEqual(f.videoSaves, []);
        assert.deepEqual(f.uploads, []);
      });
    });
  }
}

for (const [label, embedding] of [
  ["empty", []], ["short", Array(1535).fill(0)], ["long", Array(1537).fill(0)],
  ["NaN", [...Array(1535).fill(0), NaN]], ["Infinity", [...Array(1535).fill(0), Infinity]],
  ["non-number", [...Array(1535).fill(0), "0"]], ["not-array", null]
] as const) {
  for (const kind of ["ingest", "reindex"] as const) {
    test(`${kind} treats ${label} embedding as permanent and never saves or projects it`, async () => {
      await withFixture(async f => {
        if (kind === "reindex") f.seed();
        f.state.embedding = embedding as unknown as number[];
        await assert.rejects(f.run(kind === "ingest" ? job() : reindexJob()), error =>
          error instanceof PermanentError && !isTransient(error, () => false));
        assert.deepEqual(f.saves, []);
        assert.deepEqual(f.projections, []);
        assert.equal(f.videoSaves.some(value => value.status === "ready"), false);
      });
    });
  }
}

for (const [kind, phase, occurrence] of [
  ["ingest", "getVideo", 1], ["ingest", "download", 1], ["ingest", "probe", 1],
  ["ingest", "capture", 1], ["ingest", "upload:evidence", 1], ["ingest", "analyze", 1],
  ["ingest", "embed", 1], ["ingest", "embed", 2], ["ingest", "getScene", 2],
  ["ingest", "saveScene:pending", 1], ["ingest", "saveScene:pending", 2],
  ["ingest", "project", 1], ["ingest", "getVideo", 2], ["ingest", "listScenes", 1],
  ["reindex", "embed", 1], ["reindex", "saveScene:pending", 1], ["reindex", "project", 1],
  ["export", "download", 1], ["export", "probe", 1], ["export", "extract", 1],
  ["export", "zip", 1], ["export", "upload:archive", 1]
] as const) {
  test(`${kind} fences saves after lease loss during ${phase} #${occurrence}, even without signal abort`, async () => {
    await withFixture(async f => {
      f.state.probe.durationSeconds = 12;
      if (kind !== "ingest") f.seed();
      let seen = 0;
      let atLoss: { saves: number; attempts: number; videos: number; uploads: number; projects: number } | undefined;
      f.state.afterRemote = event => {
        if (event !== phase || ++seen !== occurrence) return;
        atLoss = {
          saves: f.saves.length, attempts: f.saveAttempts.length, videos: f.videoSaves.length,
          uploads: f.uploads.length, projects: f.projections.length
        };
        f.loseLease();
      };
      await assert.rejects(f.run(kind === "ingest" ? job() : kind === "reindex" ? reindexJob() : exportJob()),
        error => error === f.leaseError);
      assert.ok(atLoss, `Lease-loss hook was not reached: ${phase}`);
      assert.equal(f.context.signal.aborted, false, "This test must exercise assertOwned, not signal cancellation");
      assert.deepEqual({
        saves: f.saves.length, attempts: f.saveAttempts.length, videos: f.videoSaves.length,
        uploads: f.uploads.length, projects: f.projections.length
      }, atLoss, "No stale mutation or graph projection may start after remote work loses ownership");
    });
  });
}

test("lease loss during a rejected graph projection prevents even the failed-state save", async () => {
  await withFixture(async f => {
    f.seed();
    const failure = new Error("Remote graph failed after lease expired");
    f.state.afterRemote = event => {
      if (event === "project") {
        f.loseLease();
        throw failure;
      }
    };
    await assert.rejects(f.run(reindexJob()), error => error === f.leaseError);
    assert.deepEqual(f.saves.map(value => value.graphStatus), ["pending"]);
    assert.deepEqual(f.saveAttempts.map(value => value.graphStatus), ["pending"]);
    assert.equal(f.scenes.get("scene-0001")?.graphStatus, "pending");
  });
});

for (const phase of ["download", "probe", "extract", "zip", "upload:archive"]) {
  for (const mode of ["failure", "abort"] as const) {
    test(`export cleans workspace on ${mode} during ${phase} without successful output`, async () => {
      await withFixture(async f => {
        f.seed();
        const failure = new Error(`Test ${phase} failed`);
        let reached = false;
        f.state.afterRemote = event => {
          if (event !== phase) return;
          reached = true;
          if (mode === "abort") f.loseLease(true);
          else throw failure;
        };
        await assert.rejects(f.run(exportJob()), error => error === (mode === "abort" ? f.leaseError : failure));
        assert.equal(reached, true);
        assert.deepEqual(f.saves, []);
        assert.deepEqual(f.videoSaves, []);
        if (phase !== "upload:archive") assert.deepEqual(f.uploads, []);
      });
    });
  }
}

test("an already aborted execution performs no service work and creates no workspace", async () => {
  await withFixture(async f => {
    f.loseLease(true);
    await assert.rejects(f.run(), error => error === f.leaseError);
    assert.deepEqual(f.events, []);
  });
});

for (const phase of ["download", "probe", "capture", "upload:evidence", "analyze", "embed"]) {
  for (const mode of ["failure", "abort"] as const) {
    test(`ingest cleans partial files on ${mode} during ${phase}`, async () => {
      await withFixture(async f => {
        const failure = new Error(`Test ${phase} failed`);
        let reached = false;
        f.state.afterRemote = event => {
          if (event !== phase) return;
          reached = true;
          if (mode === "abort") f.loseLease(true);
          else throw failure;
        };
        await assert.rejects(f.run(), error => error === (mode === "abort" ? f.leaseError : failure));
        assert.equal(reached, true);
        assert.deepEqual(f.saves, []);
        assert.deepEqual(f.projections, []);
        assert.equal(f.videoSaves.some(value => value.status === "ready"), false);
      });
    });
  }
}

test("ingest rejects an empty extracted frame rather than uploading evidence or inventing analysis", async () => {
  await withFixture(async f => {
    const capture = f.media.captureFrame;
    f.media.captureFrame = async (...args) => {
      await capture(...args);
      await writeFile(args[2], "");
    };
    await assert.rejects(f.run(), PermanentError);
    assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.analyses, []);
    assert.deepEqual(f.embeddedTexts, []);
    assert.deepEqual(f.saves, []);
  });
});

test("cleanup removes only this lease workspace and preserves a concurrent owner's directory", async () => {
  await withFixture(async f => {
    const sibling = join(f.workRoot, "job-1", "another-lease");
    await mkdir(sibling, { recursive: true });
    const sentinel = join(sibling, "sentinel");
    await writeFile(sentinel, "Other owner");
    try {
      f.seed();
      await f.run(reindexJob());
      assert.equal(await readFile(sentinel, "utf8"), "Other owner");
      assert.deepEqual(await readdir(join(f.workRoot, "job-1")), ["another-lease"]);
    } finally {
      await rm(join(f.workRoot, "job-1"), { recursive: true, force: true });
    }
  });
});
