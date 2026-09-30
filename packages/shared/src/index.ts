export type Timecode = { startSeconds: number; endSeconds: number };
export type SceneEntity = {
  id: string;
  type: "person" | "animal" | "object" | "place" | "action" | "concept";
  name: string;
  confidence: number;
  actorName?: string;
  identitySource?: "editor";
};
export type SceneRelation = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  timecode: Timecode;
  evidence: string;
};
export type SceneMetadata = {
  id: string;
  videoId: string;
  videoTitle: string;
  assetUri: string;
  thumbnailUri: string;
  timecode: Timecode;
  transcript: string;
  caption: string;
  entities: SceneEntity[];
  relations: SceneRelation[];
  tags: string[];
  embedding?: number[];
  evidenceFrames: Array<{ seconds: number; uri: string }>;
  model: string;
  metadataVersion: string;
  boundarySource: "model-estimate" | "editor";
  graphStatus: "pending" | "ready" | "failed";
};
export type VideoAsset = {
  id: string;
  title: string;
  filename: string;
  status: "queued" | "processing" | "ready" | "failed";
  createdAt: string;
  durationSeconds?: number;
  fps?: number;
  sceneCount: number;
  jobId: string;
  assetUri: string;
};
export type Job = {
  id: string;
  kind: "ingest" | "export" | "reindex";
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  videoId?: string;
  sceneIds?: string[];
  outputUri?: string;
  error?: string;
};
export type QueryEntity = { variable: string; name: string; type?: SceneEntity["type"]; actorName?: string };
export type QueryRelation = { subject: string; predicate: string; object: string };
export type QueryPlan = { entities: QueryEntity[]; relations: QueryRelation[]; explanation: string };
export type SearchRequest = { query: string; limit?: number };
export type SearchHit = {
  scene: SceneMetadata;
  score: number;
  rationale: string;
  matchedTimecode: Timecode;
  graphVerified: boolean;
};
export type SearchResponse = {
  query: string;
  hits: SearchHit[];
  plan: QueryPlan;
  retrieval: "vector-graph";
  exhaustive: false;
};
export type ClipExtractionRequest = {
  clips: Array<{ sceneId: string; videoId: string; timecode: Timecode }>;
};
export type AppConfig = {
  name: string;
  mode: "azure" | "local";
  authRequired: boolean;
  aiConfigured: boolean;
  graphConfigured: boolean;
  visionModel: string;
  embeddingModel: string;
  maxUploadMb: number;
};
