import test from "node:test";
import assert from "node:assert/strict";
import { AI } from "./ai.js";
import { loadConfig } from "./config.js";
import { isPermanentError } from "./types.js";

const environment = {
  ENVIRONMENT: "local", LOCAL_AUTH_DISABLED: "true", AZURE_STORAGE_ACCOUNT: "teststore",
  COSMOS_ENDPOINT: "https://test.documents.azure.com:443/",
  GREMLIN_ENDPOINT: "wss://separate.gremlin.cosmos.azure.com:443/",
  GREMLIN_KEY: "test-only-placeholder-key", AZURE_OPENAI_ENDPOINT: "https://test.openai.azure.com",
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
  assert.throws(() => loadConfig({ ...environment, GREMLIN_ENDPOINT: "ws://insecure.example" }));
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
    assert.deepEqual(body.response_format, { type: "json_object" });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] });
  }));
  await assert.rejects(ai.plan("person sitting"), error => isPermanentError(error));
});
test("invalid, truncated, and empty embeddings are rejected", async () => {
  const ai = new AI(config, credential, fetcher(() => Response.json({ data: [{ embedding: [1] }] })));
  await assert.rejects(ai.embed("hello"), error => isPermanentError(error));
  const truncated = new AI(config, credential, fetcher(() => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] })));
  await assert.rejects(truncated.plan("hello"), error => isPermanentError(error));
});
