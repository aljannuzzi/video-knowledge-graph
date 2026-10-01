import test from "node:test";
import assert from "node:assert/strict";
import { search } from "./search.js";
import { matchTemporal } from "./temporal.js";
import type { QueryPlan } from "./index.js";
import type { SceneRecord } from "./types.js";

const scene: SceneRecord = {
  id: "scene-1", videoId: "video-1", kind: "scene", metadataVersion: "1",
  videoTitle: "Test source", assetUri: "/api/media/videos/v/source.mp4",
  thumbnailUri: "/api/media/evidence/v/frame.jpg", timecode: { startSeconds: 0, endSeconds: 12 },
  transcript: "", caption: "An anonymous person.", entities: [{ id: "p", type: "person", name: "person", confidence: 0.9 }],
  relations: [], tags: [], evidenceFrames: [], model: "model", boundarySource: "model-estimate",
  graphStatus: "ready", embedding: Array(1536).fill(0.1), updatedAt: new Date().toISOString()
};
const plan: QueryPlan = { entities: [{ variable: "x", name: "unicorn" }], relations: [], explanation: "Unknown animal requested." };
function services() {
  return {
    ai: {
      plan: async () => plan, embed: async () => Array(1536).fill(0.1),
      verifyAction: async () => { throw new Error("Entity lookup must not invoke semantic verification"); }
    },
    store: { vectorCandidates: async () => [{ scene, distance: 0.01 }], getScene: async () => scene },
    graph: {
      match: async (value: SceneRecord, query: QueryPlan) => matchTemporal(query, value.entities, value.relations, value.timecode).map(match => match.timecode),
      matchEvidence: async () => { throw new Error("Entity lookup must not need an action proof"); }
    }
  };
}
test("nonexistent search yields no fabricated hits even with a high vector score", async () => {
  const deps = services();
  deps.graph.match = async () => { throw new Error("Missing entities must be filtered before native traversal"); };
  const result = await search(deps, { query: "nonexistent unicorn" });
  assert.deepEqual(result.hits, []);
  assert.equal(result.exhaustive, false);
  assert.equal(result.retrieval, "vector-graph");
});
test("successful hits strip embeddings and require graph verification", async () => {
  const deps = services();
  deps.ai.plan = async () => ({ ...plan, entities: [{ variable: "x", name: "person" }] });
  const result = await search(deps, { query: "anonymous person" });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].scene.embedding, undefined);
  assert.equal(result.hits[0].graphVerified, true);
});
test("edited versions invalidate candidates and pending graphs are never used", async () => {
  for (const change of [{ metadataVersion: "2" }, { graphStatus: "pending" as const }]) {
    const deps = services();
    deps.store.getScene = async () => ({ ...scene, ...change });
    deps.graph.match = async () => { throw new Error("Must not traverse stale graphs"); };
    assert.deepEqual((await search(deps, { query: "person" })).hits, []);
  }
});
test("an edit during traversal suppresses the now-stale match", async () => {
  const deps = services();
  deps.ai.plan = async () => ({ ...plan, entities: [{ variable: "x", name: "person" }] });
  let reads = 0;
  deps.store.getScene = async () => ++reads === 1 ? scene : { ...scene, metadataVersion: "2" };
  deps.graph.match = async () => [scene.timecode];
  assert.deepEqual((await search(deps, { query: "person" })).hits, []);
});
