import { createHash, randomUUID } from "node:crypto";
import { CosmosClient, type Container, type RequestOptions } from "@azure/cosmos";
import type { TokenCredential } from "@azure/core-auth";
import type { Config, SceneRecord, JobRecord } from "./types.js";
import type { VideoAsset, Job } from "./index.js";
export { publicVideo, publicJob, publicScene } from "./public.js";

type VideoRecord = VideoAsset & { recordType: "video"; _etag?: string };
type StoredJob = JobRecord & { availableAt?: string };
type JobInput = { kind: Job["kind"]; videoId?: string; sceneIds?: string[]; payload: any };

function status(error: unknown): number {
  const value = error as { code?: unknown; statusCode?: unknown } | null;
  return Number(value?.statusCode ?? value?.code);
}

function failure(message: string, code: number): Error & { code: number; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode: code });
}

function body<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_"))) as T;
}

function ifMatch(etag: string | undefined): RequestOptions {
  if (!etag) throw failure("Missing concurrency token", 412);
  return { accessCondition: { type: "IfMatch", condition: etag } };
}

function resource<T>(value: T | undefined): T {
  if (!value) throw new Error("Missing database response");
  return value;
}

function seconds(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 604800) {
    throw new Error("Invalid lease duration");
  }
}

function due(value: string | undefined, now: number): boolean {
  return typeof value === "string" && Date.parse(value) <= now;
}

function claimable(job: JobRecord, now: number): boolean {
  return (job.status === "queued" && due((job as StoredJob).availableAt ?? job.nextDispatchAt, now)) ||
    (job.status === "running" && due(job.leaseUntil, now));
}

function owned(job: JobRecord | undefined, owner: string, now: number): job is JobRecord {
  return !!owner && job?.status === "running" && job.leaseOwner === owner &&
    typeof job.leaseUntil === "string" && Date.parse(job.leaseUntil) > now;
}

function reindexInput(scene: SceneRecord): JobInput {
  return {
    kind: "reindex", videoId: scene.videoId, sceneIds: [scene.id],
    payload: { videoId: scene.videoId, sceneId: scene.id, metadataVersion: scene.metadataVersion }
  };
}

function jobId(input: JobInput): string {
  if (input.kind === "ingest") {
    if (!input.videoId || !/^[a-zA-Z0-9-]{1,80}$/.test(input.videoId)) throw new Error("Invalid ingest video ID");
    return `ingest-${input.videoId}`;
  }
  if (input.kind !== "reindex") return randomUUID();
  const { videoId, sceneId, metadataVersion } = input.payload ?? {};
  if (typeof videoId !== "string" || !videoId || videoId !== input.videoId ||
      typeof sceneId !== "string" || !sceneId || input.sceneIds?.length !== 1 ||
      input.sceneIds[0] !== sceneId || typeof metadataVersion !== "string" || !metadataVersion) {
    throw new Error("Invalid reindex intent");
  }
  return `reindex-${createHash("sha256").update(JSON.stringify([videoId, sceneId, metadataVersion])).digest("hex")}`;
}

export class Store {
  readonly client: CosmosClient;
  readonly scenes: Container;
  readonly catalog: Container;

  constructor(config: Config, credential: TokenCredential) {
    this.client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential });
    const database = this.client.database(config.cosmosDatabase);
    this.scenes = database.container(config.scenesContainer);
    this.catalog = database.container(config.catalogContainer);
  }

  async getVideo(id: string): Promise<VideoAsset | undefined> {
    try {
      const { resource: video } = await this.catalog.item(id, id).read<VideoRecord>();
      return video?.recordType === "video" ? video : undefined;
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }

  async listVideos(): Promise<VideoAsset[]> {
    const { resources } = await this.catalog.items.query<VideoRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.recordType = @type ORDER BY c.createdAt DESC",
      parameters: [{ name: "@limit", value: 200 }, { name: "@type", value: "video" }]
    }).fetchAll();
    return resources;
  }

  async saveVideo(video: VideoAsset): Promise<VideoAsset> {
    const etag = (video as VideoRecord)._etag;
    const value: VideoRecord = { ...body(video), recordType: "video" };
    const response = etag
      ? await this.catalog.item(video.id, video.id).replace<VideoRecord>(value, ifMatch(etag))
      : await this.catalog.items.upsert<VideoRecord>(value);
    return resource(response.resource);
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    try {
      const { resource: job } = await this.catalog.item(id, id).read<JobRecord>();
      return job?.recordType === "job" ? job : undefined;
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }

  async listJobs(): Promise<JobRecord[]> {
    const { resources } = await this.catalog.items.query<JobRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.recordType = @type ORDER BY c.createdAt DESC",
      parameters: [{ name: "@limit", value: 200 }, { name: "@type", value: "job" }]
    }).fetchAll();
    return resources;
  }

  private pendingJob(input: JobInput, createdAt = new Date().toISOString()): JobRecord {
    return {
      id: jobId(input), recordType: "job", kind: input.kind,
      ...(input.videoId === undefined ? {} : { videoId: input.videoId }),
      ...(input.sceneIds === undefined ? {} : { sceneIds: [...input.sceneIds] }),
      payload: input.payload, status: "queued", progress: 0, stage: "queued",
      createdAt, updatedAt: createdAt, attempts: 0, nextDispatchAt: createdAt
    };
  }

  pendingIngestJob(video: Pick<VideoAsset, "id" | "assetUri" | "createdAt">): JobRecord {
    return this.pendingJob({ kind: "ingest", videoId: video.id, payload: { sourceUri: video.assetUri } }, video.createdAt);
  }

  pendingReindexJob(scene: SceneRecord): JobRecord {
    return this.pendingJob(reindexInput(scene), scene.updatedAt);
  }

  private ingestIntent(video: VideoRecord): JobRecord | undefined {
    const pending = this.pendingIngestJob(video);
    if (video.status !== "queued") return undefined;
    if (video.jobId && video.jobId !== pending.id) return undefined;
    return pending;
  }

  private reindexIntent(scene: SceneRecord): JobRecord | undefined {
    return scene.graphStatus === "pending" && scene.provenance?.reindexRequested === true
      ? this.pendingReindexJob(scene)
      : undefined;
  }

  async durableJob(id: string): Promise<JobRecord | undefined> {
    const existing = await this.getJob(id);
    if (existing) return existing;
    if (id.startsWith("ingest-")) {
      const pending = (await this.getVideo(id.slice("ingest-".length))) as VideoRecord | undefined;
      const intent = pending && this.ingestIntent(pending);
      if (intent?.id === id) return intent;
    }
    const pending = await this.scenes.items.query<SceneRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.kind = @kind AND c.graphStatus = @status AND c.provenance.reindexRequested = true",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@kind", value: "scene" },
        { name: "@status", value: "pending" }
      ]
    }).fetchAll();
    for (const scene of pending.resources) {
      const intent = this.reindexIntent(scene);
      if (intent?.id === id) return intent;
    }
    return undefined;
  }

  async listDurableJobs(): Promise<JobRecord[]> {
    const jobs = new Map((await this.listJobs()).map(job => [job.id, job]));
    const videos = await this.catalog.items.query<VideoRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.recordType = @type AND c.status = @status ORDER BY c.createdAt DESC",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@type", value: "video" },
        { name: "@status", value: "queued" }
      ]
    }).fetchAll();
    for (const video of videos.resources) {
      const intent = this.ingestIntent(video);
      if (intent && !jobs.has(intent.id)) jobs.set(intent.id, intent);
    }
    const scenes = await this.scenes.items.query<SceneRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.kind = @kind AND c.graphStatus = @status AND c.provenance.reindexRequested = true",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@kind", value: "scene" },
        { name: "@status", value: "pending" }
      ]
    }).fetchAll();
    for (const scene of scenes.resources) {
      const intent = this.reindexIntent(scene);
      if (intent && !jobs.has(intent.id)) jobs.set(intent.id, intent);
    }
    return [...jobs.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  async createJob(input: JobInput): Promise<JobRecord> {
    const value = this.pendingJob(input);
    try {
      return resource((await this.catalog.items.create<JobRecord>(value)).resource);
    } catch (error) {
      if (input.kind === "export" || status(error) !== 409) throw error;
      const existing = await this.getJob(value.id);
      if (!existing || existing.kind !== value.kind || existing.videoId !== value.videoId ||
          existing.sceneIds?.[0] !== value.sceneIds?.[0] ||
          (existing.kind === "reindex" &&
            (existing.payload as Record<string, unknown>)?.metadataVersion !==
            (value.payload as Record<string, unknown>).metadataVersion)) throw error;
      return existing;
    }
  }

  async saveJob(job: JobRecord): Promise<JobRecord> {
    const value: JobRecord = { ...body(job), recordType: "job" };
    const response = job._etag
      ? await this.catalog.item(job.id, job.id).replace<JobRecord>(value, ifMatch(job._etag))
      : await this.catalog.items.create<JobRecord>(value);
    return resource(response.resource);
  }

  async claimJob(id: string, owner: string, leaseSeconds: number): Promise<JobRecord | undefined> {
    seconds(leaseSeconds);
    if (!owner) throw new Error("Missing lease owner");
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.getJob(id);
      const now = Date.now();
      if (!job || !claimable(job, now)) return undefined;
      try {
        return await this.saveJob({
          ...job, status: "running", attempts: job.attempts + 1, leaseOwner: owner,
          leaseUntil: new Date(now + leaseSeconds * 1000).toISOString(),
          updatedAt: new Date(now).toISOString()
        });
      } catch (error) {
        if (status(error) === 404) return undefined;
        if (status(error) !== 412) throw error;
      }
    }
    return undefined;
  }

  async renewJob(id: string, owner: string, leaseSeconds: number): Promise<boolean> {
    seconds(leaseSeconds);
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.getJob(id);
      const now = Date.now();
      if (!owned(job, owner, now)) return false;
      try {
        await this.saveJob({
          ...job, leaseUntil: new Date(now + leaseSeconds * 1000).toISOString(),
          updatedAt: new Date(now).toISOString()
        });
        return true;
      } catch (error) {
        if (status(error) === 404) return false;
        if (status(error) !== 412) throw error;
      }
    }
    return false;
  }

  async updateOwnedJob(id: string, owner: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.getJob(id);
      const now = Date.now();
      if (!owned(job, owner, now)) throw failure("Job lease lost", 409);
      const value: StoredJob = { ...job };
      // Deliberately ignore identity, payload, attempts and lease ownership in patches.
      for (const key of ["status", "progress", "stage", "outputUri", "error", "nextDispatchAt"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(value, { [key]: patch[key] });
        }
      }
      if (!["queued", "running", "completed", "failed"].includes(value.status) ||
          !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100 ||
          typeof value.stage !== "string" || !Number.isFinite(Date.parse(value.nextDispatchAt))) {
        throw new Error("Invalid job update");
      }
      if (value.status !== "running") {
        if (value.status === "queued" && !due(patch.leaseUntil, now)) {
          throw new Error("Requeue requires explicit lease release");
        }
        value.leaseUntil = new Date(0).toISOString();
        delete value.leaseOwner;
        if (value.status === "queued") value.availableAt = value.nextDispatchAt;
      }
      value.updatedAt = new Date(now).toISOString();
      try {
        return await this.saveJob(value);
      } catch (error) {
        if (status(error) === 404) throw failure("Job lease lost", 409);
        if (status(error) !== 412) throw error;
      }
    }
    throw failure("Job update conflict", 412);
  }

  async noteDispatched(id: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.getJob(id);
      const now = Date.now();
      if (!job || !claimable(job, now) || !due(job.nextDispatchAt, now)) return;
      try {
        // Retry eligibility and redispatch throttling must not share a clock:
        // the just-sent message must still be claimable after this marker.
        const value: StoredJob = {
          ...job, nextDispatchAt: new Date(now + 120_000).toISOString(),
          availableAt: (job as StoredJob).availableAt ?? job.nextDispatchAt,
          updatedAt: new Date(now).toISOString()
        };
        await this.saveJob(value);
        return;
      } catch (error) {
        if (status(error) === 404) return;
        if (status(error) !== 412) throw error;
      }
    }
    throw failure("Dispatch marker conflict", 412);
  }

  private async acknowledgeReindex(scene: SceneRecord): Promise<void> {
    try {
      await this.saveScene({
        ...scene, provenance: { ...scene.provenance, reindexRequested: false }
      });
    } catch (error) {
      // A new edit must retain its own intent; ready/deleted scenes need no acknowledgement.
      if (status(error) !== 412 && status(error) !== 404) throw error;
    }
  }

  async recoverableJobs(): Promise<JobRecord[]> {
    // The first video write is also an ingest intent. Recover both historical
    // unlinked videos and deterministic job IDs whose catalog rows are missing.
    const queued = await this.catalog.items.query<VideoRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.recordType = @type AND c.status = @status ORDER BY c.createdAt DESC",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@type", value: "video" },
        { name: "@status", value: "queued" }
      ]
    }).fetchAll();
    for (const video of queued.resources) {
      const intent = this.ingestIntent(video);
      if (!intent) continue;
      const job = await this.createJob({ kind: "ingest", videoId: video.id, payload: { sourceUri: video.assetUri } });
      if (video.jobId === job.id) continue;
      try { await this.saveVideo({ ...video, jobId: job.id }); }
      catch (error) { if (status(error) !== 412) throw error; }
    }
    // Scene and catalog partitions cannot transact together. Drain a bounded,
    // persistent scene outbox first; deterministic IDs also retain terminal failures.
    const pending = await this.scenes.items.query<SceneRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.kind = @kind AND c.graphStatus = @status AND c.provenance.reindexRequested = true",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@kind", value: "scene" },
        { name: "@status", value: "pending" }
      ]
    }).fetchAll();
    for (const scene of pending.resources) {
      await this.createJob(reindexInput(scene));
      await this.acknowledgeReindex(scene);
    }
    const { resources } = await this.catalog.items.query<JobRecord>({
      query: "SELECT TOP @limit * FROM c WHERE c.recordType = @type AND c.nextDispatchAt <= @now AND ((c.status = @queued AND c.nextDispatchAt <= @now) OR (c.status = @running AND c.leaseUntil <= @now)) ORDER BY c.nextDispatchAt ASC",
      parameters: [
        { name: "@limit", value: 100 }, { name: "@type", value: "job" },
        { name: "@queued", value: "queued" }, { name: "@running", value: "running" },
        { name: "@now", value: new Date().toISOString() }
      ]
    }).fetchAll();
    return resources;
  }

  async getScene(videoId: string, id: string): Promise<SceneRecord | undefined> {
    try {
      const { resource: scene } = await this.scenes.item(id, videoId).read<SceneRecord>();
      return scene?.kind === "scene" ? scene : undefined;
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }

  async listScenes(videoId: string): Promise<SceneRecord[]> {
    const { resources } = await this.scenes.items.query<SceneRecord>({
      query: "SELECT * FROM c WHERE c.kind = @kind AND c.videoId = @videoId ORDER BY c.timecode.startSeconds ASC",
      parameters: [{ name: "@kind", value: "scene" }, { name: "@videoId", value: videoId }]
    }, { partitionKey: videoId }).fetchAll();
    return resources;
  }

  async saveScene(scene: SceneRecord): Promise<SceneRecord> {
    const value: SceneRecord = { ...body(scene), kind: "scene" };
    if (value.graphStatus === "ready" && value.provenance?.reindexRequested) {
      value.provenance = { ...value.provenance, reindexRequested: false };
    }
    const response = scene._etag
      ? await this.scenes.item(scene.id, scene.videoId).replace<SceneRecord>(value, ifMatch(scene._etag))
      : await this.scenes.items.create<SceneRecord>(value);
    return resource(response.resource);
  }

  async vectorCandidates(vector: number[], limit: number): Promise<Array<{ scene: SceneRecord; distance: number }>> {
    if (!Array.isArray(vector) || vector.length !== 1536 || !Array.from(vector).every(Number.isFinite)) {
      throw new Error("Invalid embedding");
    }
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid candidate limit");
    const { resources } = await this.scenes.items.query<{ scene: SceneRecord; distance: number }>({
      query: "SELECT TOP @limit c AS scene, VectorDistance(c.embedding, @embedding) AS distance FROM c WHERE c.kind = 'scene' AND c.graphStatus = 'ready' AND ARRAY_LENGTH(c.embedding) = 1536 ORDER BY VectorDistance(c.embedding, @embedding)",
      parameters: [{ name: "@limit", value: Math.min(limit, 100) }, { name: "@embedding", value: vector }]
    }).fetchAll();
    return resources;
  }

  async updateIdentity(videoId: string, sceneId: string, entityId: string, actorName: string): Promise<SceneRecord> {
    if (typeof actorName !== "string" || !actorName.trim() || actorName.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(actorName)) throw new Error("Invalid actor name");
    for (let attempt = 0; attempt < 4; attempt++) {
      const scene = await this.getScene(videoId, sceneId);
      if (!scene) throw failure("Scene not found", 404);
      if (!scene.entities.some(entity => entity.id === entityId && entity.type === "person")) {
        throw failure("Person entity not found", 404);
      }
      const version = Number(scene.metadataVersion);
      if (!/^\d+$/.test(scene.metadataVersion) || !Number.isSafeInteger(version) ||
          version < 0 || version >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid metadata version");
      const now = new Date().toISOString();
      let updated: SceneRecord;
      try {
        updated = await this.saveScene({
          ...scene,
          entities: scene.entities.map(entity => entity.id === entityId && entity.type === "person"
            ? { ...entity, actorName: actorName.trim(), identitySource: "editor" as const } : entity),
          metadataVersion: String(version + 1), graphStatus: "pending", embedding: [], updatedAt: now,
          provenance: {
            ...scene.provenance, reindexRequested: true,
            identityEdit: { source: "editor", at: now, entityId, scope: "person.actorName" }
          }
        });
      } catch (error) {
        if (status(error) === 412 && attempt < 3) continue;
        throw error;
      }
      return updated;
    }
    throw failure("Identity update conflict", 412);
  }
}
