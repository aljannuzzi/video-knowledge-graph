import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "./store.js";
import type { JobRecord, SceneRecord } from "./types.js";

type VideoRecord = Awaited<ReturnType<Store["getVideo"]>> & { recordType: "video" };

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
    metadataVersion: "2",
    boundarySource: "model-estimate",
    graphStatus: "pending",
    updatedAt: "2026-01-01T00:05:00.000Z",
    provenance: {
      reindexRequested: true,
      identityEdit: { source: "editor", at: "2026-01-01T00:05:00.000Z", entityId: "person-1", scope: "person.actorName" }
    }
  };
}

function video(jobId = "ingest-video-1"): Exclude<VideoRecord, undefined> {
  return {
    id: "video-1",
    title: "Video",
    filename: "video.mp4",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    sceneCount: 0,
    jobId,
    assetUri: "https://example/video.mp4",
    recordType: "video"
  };
}

function createStore(videos: Array<Exclude<VideoRecord, undefined>>, scenes: SceneRecord[], jobs: JobRecord[] = []) {
  const videoMap = new Map(videos.map((item) => [item.id, item]));
  const sceneMap = new Map(scenes.map((item) => [item.id, item]));
  const jobMap = new Map(jobs.map((item) => [item.id, item]));
  const store = Object.create(Store.prototype) as Store;
  store.getVideo = async (id: string) => videoMap.get(id);
  store.getJob = async (id: string) => jobMap.get(id);
  store.listJobs = async () => [...jobMap.values()];
  store.saveVideo = async (item) => {
    videoMap.set(item.id, { ...(item as Exclude<VideoRecord, undefined>), recordType: "video" });
    return item;
  };
  store.saveScene = async (item) => {
    sceneMap.set(item.id, item);
    return item;
  };
  store.createJob = async (input) => {
    const job = input.kind === "ingest"
      ? store.pendingIngestJob({ id: input.videoId!, assetUri: (input.payload as { sourceUri: string }).sourceUri, createdAt: "2026-01-01T00:00:00.000Z" })
      : store.pendingReindexJob(sceneMap.get(input.sceneIds![0])!);
    jobMap.set(job.id, job);
    return job;
  };
  (store as { catalog: unknown }).catalog = {
    items: {
      query: ({ query }: { query: string }) => ({
        fetchAll: async () => ({
          resources: query.includes("c.status = @status")
            ? [...videoMap.values()].filter((item) => item.status === "queued")
            : [...jobMap.values()]
        })
      })
    }
  } as unknown as Store["catalog"];
  (store as { scenes: unknown }).scenes = {
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [...sceneMap.values()].filter((item) => item.graphStatus === "pending" && item.provenance?.reindexRequested === true)
        })
      })
    }
  } as unknown as Store["scenes"];
  return { store, videoMap, sceneMap, jobMap };
}

test("durable job reads include persisted queued intents before the catalog job exists", async () => {
  const pendingScene = scene();
  const pendingVideo = video();
  const { store } = createStore([pendingVideo], [pendingScene]);
  const ingest = await store.durableJob("ingest-video-1");
  assert.equal(ingest?.status, "queued");
  assert.equal(ingest?.videoId, pendingVideo.id);
  const reindex = store.pendingReindexJob(pendingScene);
  assert.deepEqual(await store.durableJob(reindex.id), reindex);
  const listed = await store.listDurableJobs();
  assert.deepEqual(new Set(listed.map((job) => job.id)), new Set(["ingest-video-1", reindex.id]));
});

test("recoverable jobs materialize deterministic ingest intents already linked on queued videos", async () => {
  const pendingVideo = video("ingest-video-1");
  const { store, jobMap } = createStore([pendingVideo], []);
  const recovered = await store.recoverableJobs();
  assert.equal(jobMap.has("ingest-video-1"), true);
  assert.ok(recovered.some((job) => job.id === "ingest-video-1"));
});
