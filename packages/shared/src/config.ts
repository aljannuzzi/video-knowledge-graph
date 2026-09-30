import { z } from "zod";
import type { Config } from "./types.js";

const resource = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const secureUrl = (protocol: string) => z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === protocol && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, `An absolute ${protocol} URL without credentials or query is required`);

const envSchema = z.object({
  ENVIRONMENT: z.enum(["azure", "local"]).default("azure"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOCAL_AUTH_DISABLED: z.enum(["true", "false"]).default("false"),
  APP_PASSWORD: z.string().default(""),
  PUBLIC_ORIGIN: z.string().url().optional(),
  MAX_VIDEO_SECONDS: z.coerce.number().positive().max(180).default(180),
  AZURE_STORAGE_ACCOUNT: z.string().regex(/^[a-z0-9]{3,24}$/),
  AZURE_STORAGE_QUEUE: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).default("jobs"),
  COSMOS_ENDPOINT: secureUrl("https:"),
  COSMOS_DATABASE: resource.default("video-kg"),
  COSMOS_SCENES_CONTAINER: resource.default("scenes"),
  COSMOS_CATALOG_CONTAINER: resource.default("catalog"),
  GREMLIN_ENDPOINT: secureUrl("wss:"),
  GREMLIN_DATABASE: resource.default("video-kg"),
  GREMLIN_GRAPH: resource.default("knowledge"),
  GREMLIN_KEY: z.string().min(16),
  GREMLIN_PARTITION_KEY: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).default("videoId"),
  AZURE_OPENAI_ENDPOINT: secureUrl("https:"),
  AZURE_OPENAI_VISION_DEPLOYMENT: resource,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: resource.default("text-embedding-3-large"),
  AZURE_CLIENT_ID: z.string().uuid().optional()
}).superRefine((env, ctx) => {
  if (env.LOCAL_AUTH_DISABLED === "true" && env.ENVIRONMENT !== "local") {
    ctx.addIssue({ code: "custom", path: ["LOCAL_AUTH_DISABLED"], message: "Auth bypass is local-only" });
  }
  if (!(env.ENVIRONMENT === "local" && env.LOCAL_AUTH_DISABLED === "true") && env.APP_PASSWORD.length < 24) {
    ctx.addIssue({ code: "custom", path: ["APP_PASSWORD"], message: "At least 24 characters required" });
  }
  if (env.PUBLIC_ORIGIN) {
    let valid = false;
    try {
      const url = new URL(env.PUBLIC_ORIGIN);
      valid = url.origin === env.PUBLIC_ORIGIN && ["http:", "https:"].includes(url.protocol) &&
        (env.ENVIRONMENT !== "azure" || url.protocol === "https:");
    } catch { /* URL schema supplies the invalid-URL issue. */ }
    if (!valid) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_ORIGIN"], message: "Exact origin required; HTTPS in Azure" });
    }
  }
  try {
    if (new URL(env.COSMOS_ENDPOINT).hostname.split(".")[0] === new URL(env.GREMLIN_ENDPOINT).hostname.split(".")[0]) {
      ctx.addIssue({ code: "custom", path: ["GREMLIN_ENDPOINT"], message: "Use a separate Gremlin account" });
    }
  } catch { /* URL schemas supply the invalid-URL issue. */ }
});

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse({
    ...input, AZURE_STORAGE_QUEUE: input.AZURE_STORAGE_QUEUE ?? input.STORAGE_QUEUE_NAME
  });
  if (!result.success) {
    // Do not print input values (passwords, keys, or endpoints) on startup errors.
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue =>
      `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const env = result.data;
  return {
    environment: env.ENVIRONMENT, port: env.PORT,
    authDisabled: env.ENVIRONMENT === "local" && env.LOCAL_AUTH_DISABLED === "true",
    appPassword: env.APP_PASSWORD, publicOrigin: env.PUBLIC_ORIGIN,
    maxVideoSeconds: env.MAX_VIDEO_SECONDS, storageAccount: env.AZURE_STORAGE_ACCOUNT,
    queueName: env.AZURE_STORAGE_QUEUE, cosmosEndpoint: env.COSMOS_ENDPOINT,
    cosmosDatabase: env.COSMOS_DATABASE, scenesContainer: env.COSMOS_SCENES_CONTAINER,
    catalogContainer: env.COSMOS_CATALOG_CONTAINER, gremlinEndpoint: env.GREMLIN_ENDPOINT,
    gremlinDatabase: env.GREMLIN_DATABASE, gremlinGraph: env.GREMLIN_GRAPH,
    gremlinKey: env.GREMLIN_KEY, gremlinPartitionKey: env.GREMLIN_PARTITION_KEY,
    openaiEndpoint: env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, ""),
    visionDeployment: env.AZURE_OPENAI_VISION_DEPLOYMENT,
    embeddingDeployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureClientId: env.AZURE_CLIENT_ID
  };
}
