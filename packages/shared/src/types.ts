import type { Job, SceneMetadata } from "./index.js";

export interface Config {
  environment: "azure" | "local";
  port: number;
  authDisabled: boolean;
  appPassword: string;
  publicOrigin?: string;
  maxVideoSeconds: number;
  storageAccount: string;
  queueName: string;
  cosmosEndpoint: string;
  cosmosDatabase: string;
  scenesContainer: string;
  catalogContainer: string;
  gremlinEndpoint: string;
  gremlinDatabase: string;
  gremlinGraph: string;
  gremlinKey: string;
  gremlinPartitionKey: string;
  openaiEndpoint: string;
  visionDeployment: string;
  embeddingDeployment: string;
  azureClientId?: string;
}

export interface SceneRecord extends SceneMetadata {
  kind: "scene";
  embedding: number[];
  updatedAt: string;
  provenance?: Record<string, unknown>;
  _etag?: string;
}

export interface JobRecord extends Job {
  recordType: "job";
  payload: unknown;
  attempts: number;
  nextDispatchAt: string;
  availableAt?: string;
  leaseUntil?: string;
  leaseOwner?: string;
  _etag?: string;
}

export interface QueueMessage {
  jobId: string;
  messageId: string;
  popReceipt: string;
}

export class ValidationError extends Error {
  override name = "ValidationError";
}

export class GraphAccessError extends Error {
  override name = "GraphAccessError";
  readonly statusCode: number;
  constructor(statusCode: number) {
    super("Graph service authorization is unavailable");
    this.statusCode = statusCode;
  }
}

export function isPermanentError(error: unknown): boolean {
  return error instanceof ValidationError ||
    (error instanceof Error && (error.name === "ZodError" || error.name === "PermanentError"));
}
