import test from "node:test";
import assert from "node:assert/strict";
import { Graph, graphFailure, gremlinOptions } from "./graph.js";
import type { Config, SceneRecord } from "./types.js";

const scene: SceneRecord = {
  id: "scene-1", videoId: "video-1", metadataVersion: "1", kind: "scene", updatedAt: "",
  videoTitle: "Source", assetUri: "/api/media/videos/v/source.mp4", thumbnailUri: "",
  timecode: { startSeconds: 0, endSeconds: 12 }, transcript: "", caption: "Visual scene",
  entities: [{ id: "p", type: "person", name: "person", confidence: 0.9 }, { id: "s", type: "object", name: "sofa", confidence: 0.9 }],
  relations: [{ id: "r", subject: "p", predicate: "sitting_on", object: "s", confidence: 0.9, evidence: "Frame 2", timecode: { startSeconds: 2, endSeconds: 4 } }],
  tags: [], embedding: [], evidenceFrames: [], model: "vision", boundarySource: "model-estimate", graphStatus: "pending"
};
const config = { gremlinPartitionKey: "videoId", gremlinDatabase: "video-kg", gremlinGraph: "knowledge", gremlinKey: "test" } as Config;
test("projection performs native occurrence and temporal-edge writes, no JSON graph document", async () => {
  const calls: Array<{ script: string; bindings: Record<string, unknown> }> = [];
  const graph = new Graph(config, { getScene: async () => scene }, {
    submit: async (script, bindings) => { calls.push({ script, bindings }); return { toArray: () => [] }; },
    close: async () => undefined
  });
  await graph.project(scene);
  assert.ok(calls.some(call => call.script.includes("addV(")));
  assert.ok(calls.some(call => call.script.includes("addE(")));
  assert.ok(calls.some(call => call.script.includes(".property(single,")));
  assert.equal(calls.filter(call => call.bindings.vertexLabel === "Actor").length, 0);
  const observation = calls.find(call => call.bindings.edgeLabel === "observed");
  assert.ok(observation);
  assert.ok(Object.values(observation.bindings).includes("sitting_on"));
  assert.ok(Object.values(observation.bindings).includes("startSeconds"));
  assert.ok(Object.values(observation.bindings).includes(2));
});
test("Cosmos wrapped 429s are retried per operation without restarting projection", async () => {
  assert.equal(graphFailure(Object.assign(new Error("RequestRateTooLargeException"), { statusCode: 500 })).statusCode, 429);
  let first = true;
  const delays: number[] = [];
  const graph = new Graph(config, { getScene: async () => scene }, {
    submit: async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error("TooManyRequests (429)"), { statusCode: 500 });
      }
      return { toArray: () => [] };
    },
    close: async () => undefined
  }, async ms => { delays.push(ms); });
  await graph.project(scene);
  assert.deepEqual(delays, [1000]);
});
test("permanent Gremlin errors are not retried", async () => {
  let calls = 0;
  const graph = new Graph(config, { getScene: async () => scene }, {
    submit: async () => { calls++; throw Object.assign(new Error("Syntax error"), { statusCode: 400 }); },
    close: async () => undefined
  }, async () => assert.fail("Do not retry permanent errors"));
  await assert.rejects(graph.project(scene), /400/);
  assert.equal(calls, 1);
});
test("only editor assignments project canonical Actor nodes", async () => {
  const edited = { ...scene, metadataVersion: "2", entities: [{ ...scene.entities[0], actorName: "Editor Name", identitySource: "editor" as const }, scene.entities[1]] };
  const actors: Record<string, unknown>[] = [];
  const graph = new Graph(config, { getScene: async () => edited }, {
    submit: async (_script, bindings) => { if (bindings.vertexLabel === "Actor") actors.push(bindings); return { toArray: () => [] }; },
    close: async () => undefined
  });
  await graph.project(edited);
  assert.equal(actors.length, 1);
  assert.equal(actors[0].pk, "__actors");
  assert.ok(Object.values(actors[0]).includes("editor"));
});
test("stale projection is rejected before graph writes", async () => {
  const graph = new Graph(config, { getScene: async () => ({ ...scene, metadataVersion: "2" }) }, {
    submit: async () => { assert.fail("Must not write obsolete graph"); },
    close: async () => undefined
  });
  await assert.rejects(graph.project(scene), /superseded/);
});
test("Gremlin options require GraphSONv2 and verified current Node TLS", () => {
  const options = gremlinOptions(config, { driver: {
    Client: class { async submit() { return { toArray: () => [] }; } async close() {} },
    auth: { PlainTextSaslAuthenticator: class {} }
  } });
  assert.equal(options.mimeType, "application/vnd.gremlin-v2.0+json");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.connectOnStartup, false);
});
