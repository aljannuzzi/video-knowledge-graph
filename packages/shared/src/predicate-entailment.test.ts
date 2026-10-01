import test from "node:test";
import assert from "node:assert/strict";
import { compileMatch, intervalsFromRows } from "./graph-plan.js";
import { matchTemporal } from "./temporal.js";
import { observationPredicates, predicates } from "./ontology.js";
import { search } from "./search.js";
import type { QueryPlan, SceneEntity, SceneRelation } from "./index.js";
import type { SceneRecord } from "./types.js";

const timecode = { startSeconds: 0, endSeconds: 12 };
const entities: SceneEntity[] = [
  { id: "p", name: "person", type: "person", confidence: 0.9 },
  { id: "c", name: "cat", type: "animal", confidence: 0.9 },
  { id: "s", name: "sofa", type: "object", confidence: 0.9 }
];
const relation = (subject: string, predicate: string, object = "s"): SceneRelation => ({
  id: `${subject}-${predicate}`, subject, predicate, object, timecode,
  confidence: 0.9, evidence: "Observed frames"
});
const scene: SceneRecord = {
  id: "scene-1", videoId: "video-1", metadataVersion: "1", kind: "scene", updatedAt: "",
  videoTitle: "Illustrated source", assetUri: "/api/media/videos/video-1/source.mp4", thumbnailUri: "",
  timecode, transcript: "", caption: "Person and cat sitting on the same sofa.",
  entities, relations: [relation("p", "sitting_on"), relation("c", "sitting_on")], tags: [],
  evidenceFrames: [], embedding: Array(1536).fill(0.1), model: "vision", boundarySource: "model-estimate", graphStatus: "ready"
};
function plan(subjects: string[], predicate = "on"): QueryPlan {
  return {
    entities: entities.filter(e => [...subjects, "s"].includes(e.id))
      .map(e => ({ variable: e.id, name: e.name, type: e.type })),
    relations: subjects.map(subject => ({ subject, predicate, object: "s" })),
    explanation: "Requested subjects share the same sofa."
  };
}

for (const [query, subjects] of [
  ["pessoa no sofa", ["p"]],
  ["pessoa e gato no sofa", ["p", "c"]],
  ["gato no sofa", ["c"]]
] as const) {
  test(`${query}: broad surface relation retrieves the observed seated scene`, async () => {
    const parsed = plan([...subjects]);
    const result = await search({
      ai: {
        plan: async () => parsed, embed: async () => Array(1536).fill(0.1),
        verifyAction: async () => { throw new Error("Structured relation does not need action verification"); }
      },
      store: { vectorCandidates: async () => [{ scene, distance: 0.25 }], getScene: async () => scene },
      graph: {
        match: async (s, p) => matchTemporal(p, s.entities, s.relations, s.timecode).map(x => x.timecode),
        matchEvidence: async () => { throw new Error("Structured relation does not need action proof"); }
      }
    }, { query });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].scene.id, scene.id);
    assert.deepEqual(result.hits[0].matchedTimecode, timecode);
    assert.equal(result.hits[0].graphVerified, true);
  });
}

test("native SQL uses a bounded parameterized entailment set, not rewritten observations", () => {
  const query = compileMatch(plan(["c"]), scene);
  assert.match(query.script, /OPENJSON\(@predicate0\)/);
  assert.deepEqual(query.bindings.predicate0, ["on", "sitting_on", "standing_on", "lying_on"]);
  const strict = compileMatch(plan(["c"], "sitting_on"), scene);
  assert.deepEqual(strict.bindings.predicate0, ["sitting_on"]);
  assert.match(strict.script, /OPENJSON\(@predicate0\)/);
});

test("posture entails on in one direction; near/under/table seating do not entail on", () => {
  const surface = ["on", "sitting_on", "standing_on", "lying_on"];
  for (const observed of predicates) {
    const matches = matchTemporal(plan(["c"]), entities, [relation("c", observed)], timecode);
    assert.equal(matches.length > 0, surface.includes(observed), observed);
    const strict = matchTemporal(plan(["c"], "sitting_on"), entities, [relation("c", observed)], timecode);
    assert.equal(strict.length > 0, observed === "sitting_on", `strict: ${observed}`);
  }
  assert.deepEqual(observationPredicates("unknown"), ["unknown"]);
});

test("generic on preserves edge direction, shared object identity and temporal overlap", () => {
  assert.equal(matchTemporal(plan(["c"]), entities, [relation("s", "sitting_on", "c")], timecode).length, 0);
  const secondSofa = [...entities, { ...entities[2], id: "s2" }];
  assert.equal(matchTemporal(plan(["p", "c"]), secondSofa,
    [relation("p", "sitting_on"), relation("c", "lying_on", "s2")], timecode).length, 0);
  const edges = [
    { ...relation("p", "sitting_on"), timecode: { startSeconds: 0, endSeconds: 4 } },
    { ...relation("c", "lying_on"), timecode: { startSeconds: 4, endSeconds: 12 } }
  ];
  assert.deepEqual(matchTemporal(plan(["p", "c"]), entities, edges, timecode), []);
  const rows = [{ entity0: "p", entity1: "c", entity2: "s", relation0: edges[0].timecode, relation1: edges[1].timecode }];
  assert.deepEqual(intervalsFromRows(rows, plan(["p", "c"]), timecode), []);
});
