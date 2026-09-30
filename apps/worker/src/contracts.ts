import type { Job, SceneEntity, SceneMetadata, SceneRelation, Timecode, VideoAsset } from "@vkg/shared";

// Structural integration contract until @vkg/shared/server is available. No local
// service implementations or fallback data: startup requires the real exports.
export interface Config {
  environment: string;
  port: number;
  authDisabled: boolean;
  appPassword: string;
  visionDeployment: string;
  embeddingDeployment: string;
  maxVideoSeconds: number;
}

export interface SceneRecord extends SceneMetadata {
  kind: "scene";
  embedding: number[];
  updatedAt: string;
  provenance?: Record<string, unknown>;
  _etag?: string;
}

export interface JobRecord extends Job {
  payload: any;
  attempts: number;
  nextDispatchAt: string;
  leaseUntil?: string;
  leaseOwner?: string;
  _etag?: string;
}

export interface QueueMessage {
  jobId: string;
  messageId: string;
  popReceipt: string;
}

export interface Services {
  config: Config;
  store: {
    getVideo(id: string): Promise<VideoAsset | undefined>;
    saveVideo(video: VideoAsset): Promise<unknown>;
    getJob(id: string): Promise<JobRecord | undefined>;
    listJobs(): Promise<JobRecord[]>;
    createJob(input: { kind: Job["kind"]; videoId?: string; sceneIds?: string[]; payload: any }): Promise<JobRecord>;
    saveJob(job: JobRecord): Promise<JobRecord>;
    getScene(videoId: string, sceneId: string): Promise<SceneRecord | undefined>;
    listScenes(videoId: string): Promise<SceneRecord[]>;
    // Reject stale _etag writes (HTTP 412), not upsert them. An absent _etag
    // denotes create-only (HTTP 409 if present), fencing first-ingest races.
    saveScene(scene: SceneRecord): Promise<SceneRecord>;
    claimJob(id: string, owner: string, leaseSeconds: number): Promise<JobRecord | undefined>;
    renewJob(id: string, owner: string, leaseSeconds: number): Promise<boolean>;
    updateOwnedJob(id: string, owner: string, patch: Partial<JobRecord>): Promise<JobRecord>;
    recoverableJobs(): Promise<JobRecord[]>;
  };
  blobs: {
    // Required for fixed export names: use create-if-absent, returning the
    // existing URI on conflict. Unconditional overwrites let an upload already
    // in flight on an expired worker replace a newer owner's completed ZIP.
    // The current four-argument API cannot enforce that fence at the caller.
    uploadFile(container: string, name: string, path: string, contentType: string): Promise<string>;
    downloadFile(container: string, name: string, path: string): Promise<void>;
    delete(container: string, name: string): Promise<void>;
    blobNameFromUri(uri: string): { container: string; name: string };
  };
  queue: {
    client: unknown;
    dispatch(job: JobRecord): Promise<unknown>;
    receive(): Promise<QueueMessage | undefined>;
    renew(message: QueueMessage, seconds: number): Promise<QueueMessage>;
    delete(message: QueueMessage): Promise<void>;
  };
  ai: {
    analyzeFrames(frames: Array<{ seconds: number; dataUrl: string }>, timecode: Timecode): Promise<{
      caption: string; entities: SceneEntity[]; relations: SceneRelation[]; tags: string[];
    }>;
    embed(text: string): Promise<number[]>;
  };
  graph: { project(scene: SceneRecord): Promise<void>; close?(): Promise<void> };
}

export interface SharedServer {
  loadConfig(): Config;
  createServices(config: Config): Services | Promise<Services>;
  sceneEmbeddingText(scene: SceneMetadata): string;
  isPermanentError(error: unknown): boolean;
}

export async function loadSharedServer(): Promise<SharedServer> {
  // Nonliteral import allows worker compilation while the server package is
  // being implemented independently. Missing exports fail startup explicitly.
  const moduleName = "@vkg/shared/server";
  const server = await import(moduleName) as SharedServer;
  for (const name of ["loadConfig", "createServices", "sceneEmbeddingText", "isPermanentError"] as const) {
    if (typeof server[name] !== "function") throw new Error(`Missing ${moduleName} export: ${name}`);
  }
  return server;
}

export class PermanentError extends Error {
  override name = "PermanentError";
}

export class LeaseLostError extends Error {
  override name = "LeaseLostError";
}

export interface JobContext {
  signal: AbortSignal;
  assertOwned(): void;
  progress(stage: string, progress: number): Promise<void>;
}

export function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { statusCode?: number; status?: number; code?: string | number };
  return value.statusCode ?? value.status ?? value.code;
}

export function isConflict(error: unknown): boolean {
  return [409, 412, "409", "412", "PreconditionFailed", "Conflict"].includes(errorCode(error) ?? "");
}

export function isTransient(error: unknown, sharedPermanent: (error: unknown) => boolean): boolean {
  if (error instanceof PermanentError || error instanceof LeaseLostError || sharedPermanent(error)) return false;
  const code = errorCode(error);
  if (typeof code === "number") return [408, 409, 412, 429, 500, 502, 503, 504].includes(code);
  return ["408", "409", "412", "429", "500", "502", "503", "504", "ETIMEDOUT",
    "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EPIPE",
    "REQUEST_SEND_ERROR", "RestError", "ServerBusy", "OperationTimedOut"].includes(code ?? "");
}
