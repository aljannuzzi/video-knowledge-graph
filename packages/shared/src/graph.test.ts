import test from "node:test";
import assert from "node:assert/strict";
import { Graph, graphFailure, type GraphSqlClient } from "./graph.js";
import type { Config, SceneRecord } from "./types.js";
import { GraphAccessError } from "./types.js";
import { compileMatch } from "./graph-plan.js";

const scene: SceneRecord = {
  id: "scene-1", videoId: "video-1", metadataVersion: "1", kind: "scene", updatedAt: "",
  videoTitle: "Source", assetUri: "/api/media/videos/v/source.mp4", thumbnailUri: "",
  timecode: { startSeconds: 0, endSeconds: 12 }, transcript: "", caption: "Visual scene",
  entities: [{ id: "p", type: "person", name: "person", confidence: 0.9 }, { id: "s", type: "object", name: "sofa", confidence: 0.9 }],
  relations: [{ id: "r", subject: "p", predicate: "sitting_on", object: "s", confidence: 0.9, evidence: "Frame 2", timecode: { startSeconds: 2, endSeconds: 4 } }],
  tags: [], embedding: [], evidenceFrames: [], model: "vision", boundarySource: "model-estimate", graphStatus: "pending"
};
const config = { sqlGraphServer: "graph.database.windows.net", sqlGraphDatabase: "video-graph" } as Config;

function fakeClient(overrides: Partial<GraphSqlClient> = {}): GraphSqlClient {
  return {
    query: async () => [],
    transaction: async action => action({ id: Symbol("tx") }),
    close: async () => undefined,
    ...overrides
  };
}

test("projection performs native SQL graph writes with one parameterized JSON batch", async () => {
  const calls: Array<{ sql: string; parameters: readonly { name: string; value: string | number | boolean }[] }> = [];
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async (sql, parameters) => { calls.push({ sql, parameters }); return []; }
  }));
  await graph.project(scene);
  const batch = calls.find(call => call.sql.includes("OPENJSON(@data"));
  assert.ok(batch);
  assert.ok(batch.parameters.some(parameter => parameter.name === "data"));
  const payload = JSON.parse(String(batch.parameters.find(parameter => parameter.name === "data")?.value)) as {
    nodes: Array<{ entityType: string }>;
    edges: Array<{ label: string; predicate: string | null; startSeconds: number }>;
  };
  assert.ok(payload.nodes.some(node => node.entityType === "scene"));
  assert.ok(payload.edges.some(edge => edge.label === "observed" && edge.predicate === "sitting_on" && edge.startSeconds === 2));
});

test("transient SQL throttling is retried per operation without restarting projection", async () => {
  assert.equal(graphFailure(Object.assign(new Error("Please retry after 1 second"), { number: 40501 })).statusCode, 40501);
  let first = true;
  const delays: number[] = [];
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error("Please retry after 1 second"), { number: 40501, graphSql: true });
      }
      return [];
    }
  }), async ms => { delays.push(ms); });
  await graph.project(scene);
  assert.deepEqual(delays, [1000]);
});

test("permanent SQL errors are not retried", async () => {
  let calls = 0;
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async () => { calls++; throw Object.assign(new Error("Syntax error"), { number: 102, graphSql: true }); }
  }), async () => assert.fail("Do not retry permanent errors"));
  await assert.rejects(graph.project(scene), /102/);
  assert.equal(calls, 1);
});
test("projection lock contention is transient and does not leave old scene versions", async () => {
  assert.equal(graphFailure(Object.assign(new Error("Lock not acquired"), { number: 51001 })).transient, true);
  assert.equal(graphFailure(Object.assign(new Error("Lock timed out"), { number: 1222 })).transient, true);
  const calls: string[] = [];
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async statement => { calls.push(statement); return []; }
  }));
  await graph.project(scene);
  const batch = calls.find(statement => statement.includes("OPENJSON(@data"))!;
  assert.match(batch, /DELETE FROM vkg\.Edge\s+WHERE videoId = @videoId AND sceneId = @sceneId;/);
  assert.match(batch, /DELETE FROM vkg\.ProjectionState\s+WHERE videoId = @videoId AND sceneId = @sceneId;/);
});

test("only editor assignments project canonical Actor nodes", async () => {
  const edited = { ...scene, metadataVersion: "2", entities: [{ ...scene.entities[0], actorName: "Editor Name", identitySource: "editor" as const }, scene.entities[1]] };
  let data = "";
  const graph = new Graph(config, { getScene: async () => edited }, undefined, fakeClient({
    query: async (_sql, parameters) => {
      if (!parameters.some(parameter => parameter.name === "data")) return [];
      data = String(parameters.find(parameter => parameter.name === "data")?.value);
      return [];
    }
  }));
  await graph.project(edited);
  const payload = JSON.parse(data) as { nodes: Array<{ entityType: string; displayName: string; identitySource: string | null }> };
  const actors = payload.nodes.filter(node => node.entityType === "actor");
  assert.equal(actors.length, 1);
  assert.equal(actors[0].displayName, "Editor Name");
  assert.equal(actors[0].identitySource, "editor");
});

test("stale projection is rejected before graph writes", async () => {
  const graph = new Graph(config, { getScene: async () => ({ ...scene, metadataVersion: "2" }) }, undefined, fakeClient({
    query: async () => { assert.fail("Must not write obsolete graph"); }
  }));
  await assert.rejects(graph.project(scene), /superseded/);
});

test("graph authorization failures are typed and never treated as absent results or retried", async () => {
  let attempts = 0;
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async () => {
      attempts++;
      throw Object.assign(new Error("Login failed for user"), { number: 18456, graphSql: true });
    }
  }), async () => assert.fail("Authorization failures must not retry"));
  await assert.rejects(graph.project(scene), error =>
    error instanceof GraphAccessError && error.statusCode === 18456);
  assert.equal(attempts, 1);
});

test("compiled native MATCH SQL parameterizes names, actors and predicates", () => {
  const compiled = compileMatch({
    entities: [
      { variable: "a", name: "person", type: "person", actorName: "Ada'); DROP TABLE vkg.Node; --" },
      { variable: "b", name: "sofa'); DELETE FROM vkg.Edge; --", type: "object" }
    ],
    relations: [{ subject: "a", predicate: "on", object: "b" }],
    explanation: "test"
  }, scene);
  assert.match(compiled.sql, /MATCH\(root-\(contains0\)->v0 AND v0-\(identity0\)->actor0 AND root-\(contains1\)->v1 AND v0-\(e0\)->v1\)/);
  assert.doesNotMatch(compiled.sql, /DROP TABLE|DELETE FROM|Ada'\)/);
  assert.ok(compiled.parameters.some(parameter => parameter.name === "actor0" && String(parameter.value).includes("ada")));
  assert.ok(compiled.parameters.some(parameter => parameter.name === "predicate0"));
});
test("native graph inspection avoids reserved SQL alias names", async () => {
  const statements: string[] = [];
  const graph = new Graph(config, { getScene: async () => scene }, undefined, fakeClient({
    query: async statement => { statements.push(statement); return []; }
  }));
  await assert.rejects(graph.getScene(scene), /unavailable/);
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /AS contains\b|contains\./i);
    assert.match(statement, /MATCH\(root-\(membership\)->occurrence/);
  }
});

test("project rolls back atomically when the scene version changes after SQL writes", async () => {
  let reads = 0;
  let committed = false;
  let rolledBack = false;
  const graph = new Graph(config, {
    getScene: async () => (++reads < 3 ? scene : { ...scene, metadataVersion: "2" })
  }, undefined, {
    async query() { return []; },
    async transaction(action) {
      try {
        const result = await action({ id: Symbol("tx") });
        committed = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
    async close() {}
  });
  await assert.rejects(graph.project(scene), /superseded/);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});
