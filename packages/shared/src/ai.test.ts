import test from "node:test";
import assert from "node:assert/strict";
import { AI } from "./ai.js";
import { loadConfig } from "./config.js";
import { isPermanentError } from "./types.js";
import { queryPlanJsonSchema, visualSchemaForWindow } from "./schemas.js";

const environment = {
  ENVIRONMENT: "local", LOCAL_AUTH_DISABLED: "true", AZURE_STORAGE_ACCOUNT: "teststore",
  COSMOS_ENDPOINT: "https://test.documents.azure.com:443/",
  SQL_GRAPH_SERVER: "test-sql.database.windows.net",
  AZURE_OPENAI_ENDPOINT: "https://test.openai.azure.com",
  AZURE_OPENAI_VISION_DEPLOYMENT: "gpt-4.1"
};
const config = loadConfig(environment);
const credential = { getToken: async () => ({ token: "test-credential", expiresOnTimestamp: Date.now() + 3600000 }) };
const fetcher = (callback: (url: string, body: any, headers: Record<string, string>) => Response): typeof fetch =>
  (async (url, options) => callback(String(url), JSON.parse(String(options?.body)), options?.headers as Record<string, string>)) as typeof fetch;

test("startup validates local bypass, cloud password, dimensions/limits and models", () => {
  assert.equal(config.maxVideoSeconds, 180);
  assert.throws(() => loadConfig({ ...environment, ENVIRONMENT: "azure" }));
  assert.throws(() => loadConfig({ ...environment, MAX_VIDEO_SECONDS: "181" }));
  assert.throws(() => loadConfig({ ...environment, AZURE_OPENAI_VISION_DEPLOYMENT: "" }));
  assert.throws(() => loadConfig({ ...environment, SQL_GRAPH_SERVER: "ws://insecure.example" }));
});
test("actual v1 embedding request uses Entra and exactly 1536 dimensions", async () => {
  const ai = new AI(config, credential, fetcher((url, body, headers) => {
    assert.equal(url, "https://test.openai.azure.com/openai/v1/embeddings");
    assert.equal(body.dimensions, 1536);
    assert.equal(body.model, "text-embedding-3-large");
    assert.equal(headers.Authorization, "Bearer test-credential");
    return Response.json({ data: [{ embedding: Array(1536).fill(0.1) }] });
  }));
  assert.equal((await ai.embed("sofa")).length, 1536);
});
test("429 retries are bounded and honor a capped retry-after", async () => {
  let requests = 0;
  const waits: number[] = [];
  const ai = new AI(config, credential, fetcher(() => {
    requests++;
    return new Response("", { status: 429, headers: { "retry-after": "9999" } });
  }), async ms => { waits.push(ms); });
  await assert.rejects(ai.embed("sofa"), /429/);
  assert.equal(requests, 4);
  assert.deepEqual(waits, [30_000, 30_000, 30_000]);
});
test("malformed model JSON is permanent with no fallback", async () => {
  const ai = new AI(config, credential, fetcher((_url, body) => {
    assert.ok(body.max_completion_tokens);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, queryPlanJsonSchema);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] });
  }));
  await assert.rejects(ai.plan("person sitting"), error => isPermanentError(error));
});
test("query planning uses open noun vocabulary and normalizes nullable structured fields", async () => {
  const ai = new AI(config, credential, fetcher((_url, body) => {
    assert.equal(body.response_format.json_schema.schema.properties.entities.items.properties.name.enum, undefined);
    assert.match(body.messages[0].content, /Prepositions ARE relationships/);
    const plan = {
      entities: [
        { variable: "c", name: "cat", type: "animal", actorName: null },
        { variable: "s", name: "sofa", type: "object", actorName: null }
      ],
      relations: [{ subject: "c", predicate: "on", object: "s" }],
      explanation: "Gato sobre o sofá."
    };
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }] });
  }));
  const plan = await ai.plan("gato no sofa");
  assert.equal(plan.entities[0].actorName, undefined);
  assert.deepEqual(plan.relations, [{ subject: "c", predicate: "on", object: "s" }]);
});
test("invalid, truncated, and empty embeddings are rejected", async () => {
  const ai = new AI(config, credential, fetcher(() => Response.json({ data: [{ embedding: [1] }] })));
  await assert.rejects(ai.embed("hello"), error => isPermanentError(error));
  const truncated = new AI(config, credential, fetcher(() => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })));
  await assert.rejects(truncated.plan("hello"), error => isPermanentError(error));
});
test("vision extraction requests strict entity types and validates returned metadata", async () => {
  const ai = new AI(config, credential, fetcher((_url, body) => {
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema,
      visualSchemaForWindow([12], { startSeconds: 12, endSeconds: 24 }));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      caption: "Anonymous person", entities: [{ id: "p", type: "person", name: "adult", confidence: 0.9 }],
      relations: [], tags: []
    }) } }] });
  }));
  const result = await ai.analyzeFrames([{ seconds: 12, dataUrl: "data:image/jpeg;base64,AA==" }],
    { startSeconds: 12, endSeconds: 24 });
  assert.equal(result.entities[0].type, "person");
});
test("window schema cannot generate zero-length, reversed or out-of-source intervals", () => {
  const bound = { startSeconds: 36, endSeconds: 39.217 };
  const options = visualSchemaForWindow([36, 38], bound).properties.relations.items.properties.timecode.anyOf;
  for (const option of options) {
    const start = option.properties.startSeconds.enum[0];
    assert(option.properties.endSeconds.enum.every(end => end > start && end <= bound.endSeconds));
  }
  assert.equal(options[1].properties.endSeconds.enum[0], 39.217);
});
test("visual metadata validation gets one bounded corrective generation, never a success fallback", async () => {
  let calls = 0;
  const invalid = { caption: "Visible person", entities: [{ id: "p", type: "person", name: "person", confidence: 2 }], relations: [], tags: [] };
  const ai = new AI(config, credential, fetcher(() => {
    calls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(invalid) } }] });
  }));
  await assert.rejects(ai.analyzeFrames([{ seconds: 0, dataUrl: "data:image/jpeg;base64,AA==" }],
    { startSeconds: 0, endSeconds: 2 }), /schema/);
  assert.equal(calls, 2);
});
