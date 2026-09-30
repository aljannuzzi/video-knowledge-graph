import test from "node:test";
import assert from "node:assert/strict";
import type { ActionEvidence, QueryPlan, SceneRelation } from "./index.js";
import type { SceneRecord } from "./types.js";
import { actionEvidenceInterval } from "./action-evidence.js";
import { actionEvidenceSchema, queryPlanSchema } from "./schemas.js";
import { Graph } from "./graph.js";
import { graphId, occurrenceId, sceneVertexId } from "./graph-plan.js";
import type { Config } from "./types.js";
import { search } from "./search.js";

const timecode = { startSeconds: 0, endSeconds: 10 };
const relation = (id: string, subject: string, object: string, predicate: string): SceneRelation => ({
  id, subject, object, predicate, timecode: { startSeconds: 2, endSeconds: 8 },
  confidence: 0.9, evidence: "Test observation describes grooming the first dog."
});
const scene: SceneRecord = {
  id: "sample", videoId: "synthetic", metadataVersion: "1", kind: "scene", updatedAt: "",
  videoTitle: "Test", assetUri: "", thumbnailUri: "", timecode, transcript: "", caption: "Test observations",
  entities: [
    { id: "d", name: "dog", type: "animal", confidence: 0.9 },
    { id: "p", name: "person", type: "person", confidence: 0.9 },
    { id: "b", name: "comb", type: "object", confidence: 0.9 },
    { id: "d2", name: "dog", type: "animal", confidence: 0.9 }
  ],
  relations: [relation("r1", "p", "b", "using"), relation("r2", "b", "d", "touching")],
  tags: [], evidenceFrames: [], embedding: Array(1536).fill(0.1), model: "test",
  boundarySource: "model-estimate", graphStatus: "ready"
};
const plan: QueryPlan = {
  entities: [{ variable: "animal", name: "dog", type: "animal" }], relations: [],
  semanticConstraints: [{ variable: "animal", description: "The dog is being groomed." }],
  explanation: "Action requires existing evidence."
};
const proof: ActionEvidence = {
  matched: true, entityBindings: [{ variable: "animal", entityId: "d" }],
  relationIds: ["r1", "r2"], explanation: "Recorded comb use and contact describe grooming this dog."
};
test("semantic constraint schema requires declared anchors and proof on positive decisions", () => {
  assert.equal(queryPlanSchema.safeParse(plan).success, true);
  assert.equal(queryPlanSchema.safeParse({ ...plan, semanticConstraints: [{ variable: "missing", description: "grooming" }] }).success, false);
  assert.equal(actionEvidenceSchema.safeParse({ ...proof, relationIds: [] }).success, false);
  assert.equal(actionEvidenceSchema.safeParse({ ...proof, matched: false }).success, false);
});
test("semantic proof uses existing connected entity/edge identifiers and common time", () => {
  assert.deepEqual(actionEvidenceInterval(scene, plan, proof), { startSeconds: 2, endSeconds: 8 });
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, relationIds: ["invented"] }), undefined);
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, relationIds: ["r1"] }), undefined);
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, entityBindings: [{ variable: "animal", entityId: "d2" }] }), undefined);
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, entityBindings: [{ variable: "animal", entityId: "b" }] }), undefined);
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, relationIds: ["r1", "r1", "r2"] }), undefined);
  assert.equal(actionEvidenceInterval(scene, plan, { ...proof, matched: false }), undefined);
});
test("disjoint evidence and missing structured constraints do not become semantic matches", () => {
  const disjoint = { ...scene, relations: [scene.relations[0], { ...scene.relations[1], timecode: { startSeconds: 8, endSeconds: 10 } }] };
  assert.equal(actionEvidenceInterval(disjoint, plan, proof), undefined);
  const extra: QueryPlan = { ...plan, entities: [...plan.entities, { variable: "who", name: "person" }], relations: [{ subject: "who", predicate: "walking_with", object: "animal" }] };
  assert.equal(actionEvidenceInterval(scene, extra, { ...proof, entityBindings: [...proof.entityBindings, { variable: "who", entityId: "p" }] }), undefined);
  const disconnected = { ...scene, relations: [...scene.relations, relation("r3", "d2", "d2", "touching")] };
  assert.equal(actionEvidenceInterval(disconnected, plan, { ...proof, relationIds: ["r1", "r2", "r3"] }), undefined);
});
test("editor identity cannot be inferred by action verifier", () => {
  const namedPlan: QueryPlan = {
    entities: [{ variable: "who", name: "person", type: "person", actorName: "Fictional Editor Identity" }],
    relations: [], semanticConstraints: [{ variable: "who", description: "Grooming a dog." }], explanation: "Named query"
  };
  assert.equal(actionEvidenceInterval(scene, namedPlan, { ...proof, entityBindings: [{ variable: "who", entityId: "p" }] }), undefined);
});
test("native graph proof must match active stored edge identifiers, endpoints and times", async () => {
  const nodes = scene.entities.map(e => ({ id: occurrenceId(scene, e.id), label: e.name, type: e.type }));
  let edges = scene.relations.map(r => ({
    id: `observation-${graphId(sceneVertexId(scene), r.id)}`,
    source: occurrenceId(scene, r.subject), target: occurrenceId(scene, r.object),
    label: r.predicate, ...r.timecode
  }));
  const graph = new Graph({} as Config, { getScene: async () => scene }, {
    submit: async script => ({ toArray: () => script.includes(".project('id','label','type')") ? nodes : edges }),
    close: async () => undefined
  });
  assert.deepEqual(await graph.matchEvidence(scene, plan, proof), { startSeconds: 2, endSeconds: 8 });
  edges = edges.map(e => ({ ...e, endSeconds: 7 }));
  assert.equal(await graph.matchEvidence(scene, plan, proof), undefined);
});
test("search verifies actions before returning graph-backed results and rechecks version", async () => {
  let action = proof;
  let reads = 0;
  let changed = false;
  const deps = {
    ai: { plan: async () => plan, embed: async () => scene.embedding, verifyAction: async () => action },
    store: { vectorCandidates: async () => [{ scene, distance: 0.2 }], getScene: async () => {
      reads++;
      return changed && reads > 1 ? { ...scene, metadataVersion: "2" } : scene;
    } },
    graph: { match: async () => [scene.timecode], matchEvidence: async () => actionEvidenceInterval(scene, plan, action) }
  };
  assert.equal((await search(deps, { query: "dog being groomed" })).hits.length, 1);
  action = { matched: false, entityBindings: [], relationIds: [], explanation: "Only walking observed." };
  assert.equal((await search(deps, { query: "dog being groomed" })).hits.length, 0);
  action = proof; reads = 0; changed = true;
  assert.equal((await search(deps, { query: "dog being groomed" })).hits.length, 0);
});
