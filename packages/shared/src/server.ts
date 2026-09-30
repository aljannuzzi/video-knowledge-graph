import { DefaultAzureCredential } from "@azure/identity";
import type { Config } from "./types.js";
import { Store } from "./store.js";
import { Blobs } from "./blobs.js";
import { Queue } from "./queue.js";
import { AI } from "./ai.js";
import { Graph } from "./graph.js";

export function createServices(config: Config) {
  const credential = new DefaultAzureCredential({
    ...(config.azureClientId ? { managedIdentityClientId: config.azureClientId } : {})
  });
  const store = new Store(config, credential);
  return {
    config, store, blobs: new Blobs(config, credential),
    queue: new Queue(config, credential, store),
    ai: new AI(config, credential), graph: new Graph(config, store)
  };
}

export type Services = ReturnType<typeof createServices>;
export { loadConfig } from "./config.js";
export { publicScene, publicJob, publicVideo } from "./store.js";
export { blobNameFromUri } from "./blobs.js";
export { sceneEmbeddingText } from "./ai.js";
export { search } from "./search.js";
export { searchRequestSchema, clipRequestSchema, identityRequestSchema } from "./schemas.js";
export { ValidationError, isPermanentError } from "./types.js";
export type { Config, SceneRecord, JobRecord, QueueMessage } from "./types.js";
