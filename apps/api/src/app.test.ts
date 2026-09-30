import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { JobRecord, SceneRecord } from "@vkg/shared/server";
import { createApp } from "./app.js";

type Services = Parameters<typeof createApp>[0];

function config() {
  return {
    environment: "local" as const,
    port: 0,
    authDisabled: true,
    appPassword: "",
    maxVideoSeconds: 600,
    storageAccount: "storageacct",
    queueName: "video-jobs",
    cosmosEndpoint: "https://example.documents.azure.com:443/",
    cosmosDatabase: "db",
    scenesContainer: "scenes",
    catalogContainer: "catalog",
    gremlinEndpoint: "wss://example.gremlin.cosmos.azure.com:443/",
    gremlinDatabase: "graph-db",
    gremlinGraph: "graph",
    gremlinKey: "key",
    gremlinPartitionKey: "/pk",
    openaiEndpoint: "https://example.openai.azure.com/",
    visionDeployment: "vision",
    embeddingDeployment: "embedding"
  };
}

function scene(): SceneRecord {
  return {
    id: "scene-1",
    kind: "scene",
    videoId: "video-1",
    videoTitle: "Video",
    assetUri: "https://example/video.mp4",
    thumbnailUri: "https://example/thumb.jpg",
    timecode: { startSeconds: 0, endSeconds: 5 },
    transcript: "hello",
    caption: "caption",
    entities: [{ id: "person-1", type: "person", name: "Person", confidence: 0.9 }],
    relations: [],
    tags: [],
    embedding: [0],
    evidenceFrames: [],
    model: "model",
    metadataVersion: "1",
    boundarySource: "model-estimate",
    graphStatus: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
    provenance: {}
  };
}

async function withServer(services: Services, run: (base: string) => Promise<void>) {
  const server = createApp(services).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("upload accepts a durable ingest intent even when catalog job creation fails", async () => {
  let savedVideo: { id: string; jobId: string; assetUri: string; createdAt: string } | undefined;
  let dispatched = false;
  const sourceUri = "https://blob/videos/video-1/source.mp4";
  const pendingJob: JobRecord = {
    id: "ingest-video-1",
    recordType: "job",
    kind: "ingest",
    videoId: "video-1",
    payload: { sourceUri },
    status: "queued",
    progress: 0,
    stage: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    nextDispatchAt: "2026-01-01T00:00:00.000Z"
  };
  const services = {
    config: config(),
    blobs: {
      uploadFile: async () => sourceUri
    },
    queue: {
      dispatch: async () => { dispatched = true; }
    },
    store: {
      listVideos: async () => [],
      getVideo: async () => undefined,
      saveVideo: async (video: typeof savedVideo extends undefined ? never : any) => { savedVideo = video; return video; },
      createJob: async () => { throw new Error("catalog write failed"); },
      pendingIngestJob: (video: { id: string; assetUri: string; createdAt: string }) => ({
        ...pendingJob,
        id: `ingest-${video.id}`,
        videoId: video.id,
        payload: { sourceUri: video.assetUri },
        createdAt: video.createdAt,
        updatedAt: video.createdAt,
        nextDispatchAt: video.createdAt
      }),
      durableJob: async (id: string) => id === savedVideo?.jobId
        ? {
          ...pendingJob,
          id,
          videoId: savedVideo.id,
          payload: { sourceUri: savedVideo.assetUri },
          createdAt: savedVideo.createdAt,
          updatedAt: savedVideo.createdAt,
          nextDispatchAt: savedVideo.createdAt
        }
        : undefined,
      listDurableJobs: async () => savedVideo ? [await (services.store as any).durableJob(savedVideo.jobId)] : [],
      getScene: async () => undefined,
      listScenes: async () => [],
      updateIdentity: async () => { throw new Error("unused"); },
      pendingReindexJob: () => { throw new Error("unused"); }
    },
    graph: { getScene: async () => ({}) },
    ai: {}
  } as unknown as Services;
  await withServer(services, async (base) => {
    const form = new FormData();
    form.append("title", "Uploaded title");
    form.append("video", new Blob(["video-bytes"], { type: "video/mp4" }), "clip.mp4");
    const upload = await fetch(`${base}/api/videos`, { method: "POST", body: form });
    assert.equal(upload.status, 202);
    const accepted = await upload.json() as { video: { jobId: string; title: string }; job: { id: string; status: string } };
    assert.equal(accepted.video.title, "Uploaded title");
    assert.equal(accepted.video.jobId, accepted.job.id);
    assert.equal(accepted.job.status, "queued");
    assert.equal(savedVideo?.jobId, accepted.job.id);
    assert.equal(dispatched, false);
    const poll = await fetch(`${base}/api/jobs/${accepted.job.id}`);
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), accepted.job);
  });
});

test("identity edits return 202 and durable job location when reindex job creation is deferred", async () => {
  let current = scene();
  let dispatched = false;
  const services = {
    config: config(),
    blobs: { uploadFile: async () => "unused" },
    queue: { dispatch: async () => { dispatched = true; } },
    store: {
      listVideos: async () => [],
      getVideo: async () => ({ id: "video-1", title: "Video", filename: "video.mp4", status: "queued", createdAt: current.updatedAt, sceneCount: 1, jobId: "", assetUri: current.assetUri }),
      saveVideo: async (video: unknown) => video,
      createJob: async () => { throw new Error("catalog write failed"); },
      pendingIngestJob: () => { throw new Error("unused"); },
      durableJob: async (id: string) => {
        const job = (services.store as any).pendingReindexJob(current);
        return job.id === id ? job : undefined;
      },
      listDurableJobs: async () => [await (services.store as any).durableJob((services.store as any).pendingReindexJob(current).id)],
      getScene: async () => current,
      listScenes: async () => [current],
      updateIdentity: async (_videoId: string, _sceneId: string, entityId: string, actorName: string) => {
        current = {
          ...current,
          metadataVersion: "2",
          graphStatus: "pending",
          updatedAt: "2026-01-01T00:05:00.000Z",
          entities: current.entities.map((entity) => entity.id === entityId
            ? { ...entity, actorName, identitySource: "editor" as const }
            : entity),
          provenance: {
            reindexRequested: true,
            identityEdit: { source: "editor", at: "2026-01-01T00:05:00.000Z", entityId, scope: "person.actorName" }
          }
        };
        return current;
      },
      pendingReindexJob: (updated: SceneRecord): JobRecord => ({
        id: "reindex-scene-1-v2",
        recordType: "job",
        kind: "reindex",
        videoId: updated.videoId,
        sceneIds: [updated.id],
        payload: { videoId: updated.videoId, sceneId: updated.id, metadataVersion: updated.metadataVersion },
        status: "queued",
        progress: 0,
        stage: "queued",
        createdAt: updated.updatedAt,
        updatedAt: updated.updatedAt,
        attempts: 0,
        nextDispatchAt: updated.updatedAt
      })
    },
    graph: { getScene: async () => ({}) },
    ai: {}
  } as unknown as Services;
  await withServer(services, async (base) => {
    const response = await fetch(`${base}/api/videos/video-1/scenes/scene-1/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityId: "person-1", actorName: "Alex" })
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-identity-scope"), "This scene occurrence only; no cross-scene identity inference");
    const location = response.headers.get("location");
    assert.ok(location);
    const body = await response.json() as { metadataVersion: string; graphStatus: string; entities: Array<{ actorName?: string; identitySource?: string }> };
    assert.equal(body.metadataVersion, "2");
    assert.equal(body.graphStatus, "pending");
    assert.deepEqual(body.entities[0], { id: "person-1", type: "person", name: "Person", confidence: 0.9, actorName: "Alex", identitySource: "editor" });
    assert.equal(dispatched, false);
    const poll = await fetch(`${base}${location}`);
    assert.equal(poll.status, 200);
    const job = await poll.json() as { status: string; kind: string };
    assert.equal(job.status, "queued");
    assert.equal(job.kind, "reindex");
  });
});
