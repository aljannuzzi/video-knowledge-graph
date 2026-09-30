import test from "node:test";
import assert from "node:assert/strict";
import { intersectIntervals, matchTemporal } from "./temporal.js";
import { compileMatch, intervalsFromRows, occurrenceId } from "./graph-plan.js";
import { queryPlanSchema, validateVisualAnalysis, clipRequestSchema, timecodeSchema } from "./schemas.js";
import type { QueryPlan, SceneEntity, SceneRelation } from "./index.js";
import type { SceneRecord } from "./types.js";

const entities: SceneEntity[] = [
  { id: "p1", name: "person", type: "person", confidence: 0.9 },
  { id: "s1", name: "sofa", type: "object", confidence: 0.9 },
  { id: "s2", name: "sofa", type: "object", confidence: 0.9 },
  { id: "d1", name: "dog", type: "animal", confidence: 0.9 }
];
const plan: QueryPlan = {
  entities: [{ variable: "p", name: "person" }, { variable: "s", name: "sofa" }, { variable: "d", name: "dog" }],
  relations: [{ subject: "p", predicate: "sitting_on", object: "s" }, { subject: "d", predicate: "next_to", object: "s" }],
  explanation: "Person and dog refer to the same sofa at the same time."
};
const relation = (id: string, subject: string, predicate: string, object: string, start = 1, end = 8): SceneRelation =>
  ({ id, subject, predicate, object, timecode: { startSeconds: start, endSeconds: end }, confidence: 0.9, evidence: "Frames 2 and 4" });
const bounds = { startSeconds: 0, endSeconds: 12 };
const scene = { videoId: "video", id: "scene-1", metadataVersion: "1", timecode: bounds } as SceneRecord;

test("same variable binds one sofa and returns common temporal interval", () => {
  const matches = matchTemporal(plan, entities, [
    relation("r1", "p1", "sitting_on", "s1", 1, 8),
    relation("r2", "d1", "next_to", "s1", 4, 10)
  ], bounds);
  assert.deepEqual(matches, [{ bindings: { p: "p1", s: "s1", d: "d1" }, timecode: { startSeconds: 4, endSeconds: 8 } }]);
});
test("different sofas are not a shared sofa match", () => {
  assert.equal(matchTemporal(plan, entities, [
    relation("r1", "p1", "sitting_on", "s1"), relation("r2", "d1", "next_to", "s2")
  ], bounds).length, 0);
});
test("touching interval boundaries and pairwise-only overlaps do not match", () => {
  assert.equal(intersectIntervals([{ startSeconds: 0, endSeconds: 5 }, { startSeconds: 5, endSeconds: 8 }]), undefined);
  assert.equal(intersectIntervals([{ startSeconds: 0, endSeconds: 4 }, { startSeconds: 3, endSeconds: 6 }, { startSeconds: 5, endSeconds: 8 }]), undefined);
  assert.equal(matchTemporal(plan, entities, [
    relation("r1", "p1", "sitting_on", "s1", 0, 4), relation("r2", "d1", "next_to", "s1", 4, 9)
  ], bounds).length, 0);
});
test("unknown objects and missing relations have no matches", () => {
  assert.equal(matchTemporal({ entities: [{ variable: "x", name: "unicorn" }], relations: [], explanation: "Unknown" },
    entities, [], bounds).length, 0);
  assert.equal(matchTemporal(plan, entities, [], bounds).length, 0);
});
test("actor matching requires explicit editor identity", () => {
  const actorPlan: QueryPlan = { entities: [{ variable: "p", name: "person", type: "person", actorName: "A Name" }], relations: [], explanation: "Editor identity" };
  assert.equal(matchTemporal(actorPlan, [{ ...entities[0], actorName: "A Name" }], [], bounds).length, 0);
  assert.equal(matchTemporal(actorPlan, [{ ...entities[0], actorName: "A Name", identitySource: "editor" }], [], bounds).length, 1);
});
test("bounded native template reuses the sofa alias and binds all untrusted values", () => {
  const query = compileMatch(plan, scene);
  assert.equal((query.script.match(/\.(inV|otherV)\(\)\.where\(eq\('v1'\)\)/g) ?? []).length, 2);
  assert.match(query.script, /\.limit\(256\)/);
  const malicious = compileMatch({ entities: [{ variable: "p", name: "x');g.V().drop();//" }], relations: [], explanation: "test" }, scene);
  assert.ok(!malicious.script.includes("drop"));
  assert.equal(malicious.bindings.name0, "x');g.v().drop();//");
  assert.throws(() => compileMatch({ ...plan, entities: [{ variable: "p');drop(", name: "person" }] }, scene));
});
test("symmetric observations match either direction without weakening sofa binding", () => {
  assert.equal(matchTemporal(plan, entities, [
    relation("r1", "p1", "sitting_on", "s1"),
    relation("r2", "s1", "next_to", "d1")
  ], bounds).length, 1);
  assert.match(compileMatch(plan, scene).script, /\.bothE\('observed'\)/);
});
test("occurrence keys include video scene and metadata version", () => {
  assert.notEqual(occurrenceId(scene, "p1"), occurrenceId({ ...scene, metadataVersion: "2" }, "p1"));
  assert.notEqual(occurrenceId(scene, "p1"), occurrenceId({ ...scene, videoId: "other" }, "p1"));
});
test("native result intervals are independently validated and intersected", () => {
  const row = { entity0: "p1", entity1: "s1", entity2: "d1", relation0: { startSeconds: 2, endSeconds: 8 }, relation1: { startSeconds: 4, endSeconds: 9 } };
  assert.deepEqual(intervalsFromRows([row], plan, bounds), [{ startSeconds: 4, endSeconds: 8 }]);
  assert.deepEqual(intervalsFromRows([{ ...row, relation1: { startSeconds: 8, endSeconds: 9 } }], plan, bounds), []);
  assert.deepEqual(intervalsFromRows([{ ...row, relation1: { startSeconds: -1, endSeconds: 9 } }], plan, bounds), []);
});
test("schemas reject unknown keys, dangling references, duplicate variables and time errors", () => {
  assert.equal(queryPlanSchema.safeParse({ ...plan, script: "g.V()" }).success, false);
  assert.equal(queryPlanSchema.safeParse({ ...plan, relations: [{ subject: "missing", predicate: "near", object: "s" }] }).success, false);
  assert.equal(queryPlanSchema.safeParse({ ...plan, entities: [plan.entities[0], plan.entities[0]] }).success, false);
  for (const timecode of [{ startSeconds: 0, endSeconds: 0 }, { startSeconds: -1, endSeconds: 1 }, { startSeconds: 2, endSeconds: 1 }, { startSeconds: 0, endSeconds: Infinity }]) {
    assert.equal(timecodeSchema.safeParse(timecode).success, false);
  }
  assert.equal(clipRequestSchema.safeParse({ clips: [{ videoId: "v", sceneId: "../escape", timecode: bounds }] }).success, false);
});
test("unconnected entity conjunctions cannot claim a shared temporal interval", () => {
  const unconnected: QueryPlan = {
    entities: [{ variable: "p", name: "person" }, { variable: "d", name: "dog" }],
    relations: [], explanation: "No temporal relation evidence"
  };
  assert.equal(queryPlanSchema.safeParse(unconnected).success, false);
  assert.deepEqual(matchTemporal(unconnected, entities, [], bounds), []);
  assert.deepEqual(intervalsFromRows([{ entity0: "p1", entity1: "d1" }], unconnected, bounds), []);
  const extra = { ...plan, entities: [...plan.entities, { variable: "x", name: "table" }] };
  assert.equal(queryPlanSchema.safeParse(extra).success, false);
});
test("anonymous age categories remain searchable without accepting visual identities", () => {
  const child: SceneEntity = { id: "c1", name: "child", type: "person", confidence: 0.9 };
  const generic: QueryPlan = { entities: [{ variable: "p", name: "person", type: "person" }], relations: [], explanation: "Any person" };
  assert.equal(matchTemporal(generic, [child], [], bounds).length, 1);
  assert.match(compileMatch(generic, scene).script, /\.has\('entityType','person'\)/);
  assert.equal(validateVisualAnalysis({ caption: "Child", entities: [child], relations: [], tags: [] }, bounds).entities[0].name, "child");
});
test("known ontology types are identical in model queries and observations", () => {
  const query = queryPlanSchema.parse({ entities: [{ variable: "g", name: "cat", type: "object" }], relations: [], explanation: "Pet" });
  assert.equal(query.entities[0].type, "animal");
  const observation = validateVisualAnalysis({
    caption: "Gato", entities: [{ id: "c1", type: "object", name: "cat", confidence: 0.9 }], relations: [], tags: []
  }, bounds);
  assert.equal(observation.entities[0].type, "animal");
});
test("vision names are discarded, invalid relations and model identities fail closed", () => {
  const valid = { caption: "Visual-only", entities: [{ ...entities[0], name: "A visual celebrity guess" }, entities[1]], relations: [relation("r1", "p1", "sitting_on", "s1")], tags: [] };
  assert.equal(validateVisualAnalysis(valid, bounds).entities[0].name, "person");
  assert.throws(() => validateVisualAnalysis({ ...valid, entities: [{ ...valid.entities[0], actorName: "Guess" }, entities[1]] }, bounds));
  assert.throws(() => validateVisualAnalysis({ ...valid, relations: [relation("r1", "p1", "near", "missing")] }, bounds));
  assert.throws(() => validateVisualAnalysis({ ...valid, relations: [relation("r1", "p1", "near", "s1", 0, 13)] }, bounds));
});
