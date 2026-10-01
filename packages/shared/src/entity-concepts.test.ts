import test from "node:test";
import assert from "node:assert/strict";
import { canonicalEntityName, observationEntityNames } from "./ontology.js";
import { entityMatches, matchTemporal } from "./temporal.js";
import { compileMatch } from "./graph-plan.js";
import { queryPlanSchema, validateVisualAnalysis } from "./schemas.js";
import type { QueryPlan, SceneEntity } from "./index.js";
import type { SceneRecord } from "./types.js";

const bounds = { startSeconds: 0, endSeconds: 12 };
const plan: QueryPlan = {
  entities: [{ variable: "a", name: "sea lion", type: "animal" }, { variable: "p", name: "aquatic tank", type: "place" }],
  relations: [{ subject: "a", predicate: "inside", object: "p" }],
  semanticConstraints: [{ variable: "a", description: "The sea lion is swimming." }],
  explanation: "A supported species and water enclosure."
};
test("safe concept aliases do not equate different marine animals or unrelated tanks", () => {
  assert.equal(canonicalEntityName("Sea-Lion"), "sea lion");
  assert.equal(canonicalEntityName("swimming pool"), "pool");
  assert.equal(canonicalEntityName("tank"), "tank");
  assert.equal(canonicalEntityName("seal"), "seal");
  assert.equal(canonicalEntityName("dolphin"), "dolphin");
  assert(!observationEntityNames("sea lion").includes("seal"));
  assert(!observationEntityNames("pool").includes("tank"));
  for (const name of ["seal", "dolphin", "lion"]) {
    assert.equal(entityMatches({ id: "a", type: "animal", name, confidence: 0.9 }, plan.entities[0]), false);
  }
});
test("aquatic containers match stored object/place classifications through safe aliases", () => {
  const parsed = queryPlanSchema.parse(plan);
  assert.equal(parsed.entities[1].name, "pool");
  assert.equal(parsed.entities[1].type, "object");
  for (const type of ["object", "place"] as const) {
    const entities: SceneEntity[] = [
      { id: "animal", type: "animal", name: "sea lion", confidence: 0.9 },
      { id: "water", type, name: "pool", confidence: 0.9 }
    ];
    assert.equal(matchTemporal(parsed, entities, [{
      id: "r1", subject: "animal", predicate: "inside", object: "water",
      timecode: { startSeconds: 2, endSeconds: 8 }, confidence: 0.9, evidence: "Temporal observation."
    }], bounds).length, 1);
  }
});
test("native query compiler binds safe alias sets rather than interpolating labels", () => {
  const compiled = compileMatch(plan, { videoId: "v", id: "s", metadataVersion: "1" } as SceneRecord);
  assert.match(compiled.script, /OPENJSON\(@name0\)/);
  assert.match(compiled.script, /OPENJSON\(@name1\)/);
  assert.match(compiled.script, /OPENJSON\(@type1\)/);
  assert.deepEqual(compiled.bindings.type1, ["object", "place"]);
  assert.deepEqual(compiled.bindings.name0, ["sea lion", "sea-lion", "sealion"]);
});
test("visual normalization preserves supported taxonomy instead of deriving species from caption", () => {
  const result = validateVisualAnalysis({
    caption: "An ambiguous marine animal.", tags: [], relations: [],
    entities: [{ id: "a", name: "seal", type: "animal", confidence: 0.7 }]
  }, bounds);
  assert.equal(result.entities[0].name, "seal");
});
test("human age categories are normalized to person without admitting arbitrary entity types", () => {
  for (const name of ["adult", "child"]) {
    const result = validateVisualAnalysis({
      caption: "Anonymous people.", tags: [], relations: [],
      entities: [{ id: "p", name, type: name, confidence: 0.9 }]
    }, bounds);
    assert.equal(result.entities[0].type, "person");
    assert.equal(result.entities[0].name, name);
  }
  assert.throws(() => validateVisualAnalysis({
    caption: "Untrusted output", tags: [], relations: [],
    entities: [{ id: "p", name: "person", type: "celebrity", confidence: 0.9 }]
  }, bounds));
});
