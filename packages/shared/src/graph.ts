import { createRequire } from "node:module";
import type { TokenCredential } from "@azure/core-auth";
import type { Config, SceneRecord } from "./types.js";
import { GraphAccessError } from "./types.js";
import type { ActionEvidence, QueryPlan, Timecode } from "./index.js";
import type { Store } from "./store.js";
import { compileMatch, graphId, intervalsFromRows, occurrenceId, sceneVertexId, type SqlParameter } from "./graph-plan.js";
import { normalizeLabel, symmetricPredicates } from "./ontology.js";
import { actionEvidenceInterval } from "./action-evidence.js";

type SqlRow = Record<string, unknown>;
type SqlError = Error & {
  graphSql?: boolean;
  statusCode?: number;
  code?: string | number;
  number?: number;
  originalError?: { info?: { number?: number; message?: string } };
  precedingErrors?: Array<{ number?: number; message?: string }>;
};

interface SqlTransaction {
  readonly id: unknown;
}

export interface GraphSqlClient {
  query<T extends SqlRow = SqlRow>(
    sql: string,
    parameters: readonly SqlParameter[],
    transaction?: SqlTransaction
  ): Promise<T[]>;
  transaction<T>(action: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type GraphNode = { id: string; label: string; type: string };
type GraphEdge = { id: string; source: string; target: string; label: string; startSeconds: number; endSeconds: number };
type ProjectionNode = {
  nodeKey: string;
  entityType: string;
  videoId: string | null;
  sceneId: string | null;
  metadataVersion: string | null;
  entityId: string | null;
  displayName: string;
  nameNormalized: string | null;
  identitySource: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
};
type ProjectionEdge = {
  edgeKey: string;
  sceneId: string;
  videoId: string;
  metadataVersion: string;
  label: "contains" | "observed" | "identifiedAs";
  predicate: string | null;
  sourceNodeKey: string;
  targetNodeKey: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number | null;
  evidence: string | null;
  isReverse: boolean;
};
type ProjectionPayload = { nodes: ProjectionNode[]; edges: ProjectionEdge[] };
export type MaterializedGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

const SQL_SCOPE = "https://database.windows.net/.default";
const SQL_REQUEST_TIMEOUT_MS = 30_000;
const SQL_MAX_RETRIES = 4;
const LOCK_SQL = `
DECLARE @lockResult int;
EXEC @lockResult = sp_getapplock
  @Resource = @resource,
  @LockMode = 'Exclusive',
  @LockOwner = 'Transaction',
  @LockTimeout = 10000;
IF @lockResult < 0
  THROW 51001, 'Graph projection lock not acquired', 1;`;
const PROJECT_SQL = `
DELETE FROM vkg.Edge
WHERE videoId = @videoId AND sceneId = @sceneId;

DELETE FROM vkg.ProjectionState
WHERE videoId = @videoId AND sceneId = @sceneId;

DELETE FROM vkg.Node
WHERE videoId = @videoId AND sceneId = @sceneId
  AND entityType <> N'actor';

DECLARE @nodes TABLE (
  nodeKey NVARCHAR(130) NOT NULL,
  entityType NVARCHAR(32) NOT NULL,
  videoId NVARCHAR(128) NULL,
  sceneId NVARCHAR(128) NULL,
  metadataVersion NVARCHAR(64) NULL,
  entityId NVARCHAR(128) NULL,
  displayName NVARCHAR(4000) NOT NULL,
  nameNormalized NVARCHAR(200) NULL,
  identitySource NVARCHAR(32) NULL,
  startSeconds FLOAT NULL,
  endSeconds FLOAT NULL
);

INSERT INTO @nodes (
  nodeKey, entityType, videoId, sceneId, metadataVersion, entityId,
  displayName, nameNormalized, identitySource, startSeconds, endSeconds
)
SELECT
  nodeKey, entityType, videoId, sceneId, metadataVersion, entityId,
  displayName, nameNormalized, identitySource, startSeconds, endSeconds
FROM OPENJSON(@data, '$.nodes') WITH (
  nodeKey NVARCHAR(130) '$.nodeKey',
  entityType NVARCHAR(32) '$.entityType',
  videoId NVARCHAR(128) '$.videoId',
  sceneId NVARCHAR(128) '$.sceneId',
  metadataVersion NVARCHAR(64) '$.metadataVersion',
  entityId NVARCHAR(128) '$.entityId',
  displayName NVARCHAR(4000) '$.displayName',
  nameNormalized NVARCHAR(200) '$.nameNormalized',
  identitySource NVARCHAR(32) '$.identitySource',
  startSeconds FLOAT '$.startSeconds',
  endSeconds FLOAT '$.endSeconds'
);

UPDATE existing
SET displayName = source.displayName,
    nameNormalized = source.nameNormalized,
    identitySource = source.identitySource
FROM vkg.Node AS existing
JOIN @nodes AS source
  ON source.entityType = N'actor' AND existing.nodeKey = source.nodeKey;

INSERT INTO vkg.Node (
  nodeKey, entityType, videoId, sceneId, metadataVersion, entityId,
  displayName, nameNormalized, identitySource, startSeconds, endSeconds
)
SELECT
  source.nodeKey, source.entityType, source.videoId, source.sceneId, source.metadataVersion, source.entityId,
  source.displayName, source.nameNormalized, source.identitySource, source.startSeconds, source.endSeconds
FROM @nodes AS source
WHERE NOT EXISTS (
  SELECT 1
  FROM vkg.Node AS existing WITH (UPDLOCK, HOLDLOCK)
  WHERE existing.nodeKey = source.nodeKey
);

DECLARE @edges TABLE (
  edgeKey NVARCHAR(160) NOT NULL,
  sceneId NVARCHAR(128) NOT NULL,
  videoId NVARCHAR(128) NOT NULL,
  metadataVersion NVARCHAR(64) NOT NULL,
  label NVARCHAR(32) NOT NULL,
  predicate NVARCHAR(64) NULL,
  sourceNodeKey NVARCHAR(130) NOT NULL,
  targetNodeKey NVARCHAR(130) NOT NULL,
  startSeconds FLOAT NOT NULL,
  endSeconds FLOAT NOT NULL,
  confidence FLOAT NULL,
  evidence NVARCHAR(1000) NULL,
  isReverse BIT NOT NULL
);

INSERT INTO @edges (
  edgeKey, sceneId, videoId, metadataVersion, label, predicate,
  sourceNodeKey, targetNodeKey, startSeconds, endSeconds, confidence, evidence, isReverse
)
SELECT
  edgeKey, sceneId, videoId, metadataVersion, label, predicate,
  sourceNodeKey, targetNodeKey, startSeconds, endSeconds, confidence, evidence, isReverse
FROM OPENJSON(@data, '$.edges') WITH (
  edgeKey NVARCHAR(160) '$.edgeKey',
  sceneId NVARCHAR(128) '$.sceneId',
  videoId NVARCHAR(128) '$.videoId',
  metadataVersion NVARCHAR(64) '$.metadataVersion',
  label NVARCHAR(32) '$.label',
  predicate NVARCHAR(64) '$.predicate',
  sourceNodeKey NVARCHAR(130) '$.sourceNodeKey',
  targetNodeKey NVARCHAR(130) '$.targetNodeKey',
  startSeconds FLOAT '$.startSeconds',
  endSeconds FLOAT '$.endSeconds',
  confidence FLOAT '$.confidence',
  evidence NVARCHAR(1000) '$.evidence',
  isReverse BIT '$.isReverse'
);

INSERT INTO vkg.Edge (
  $from_id, $to_id, edgeKey, sceneId, videoId, metadataVersion, label, predicate,
  sourceNodeKey, targetNodeKey, startSeconds, endSeconds, confidence, evidence, isReverse
)
SELECT
  source.$node_id,
  target.$node_id,
  edge.edgeKey,
  edge.sceneId,
  edge.videoId,
  edge.metadataVersion,
  edge.label,
  edge.predicate,
  edge.sourceNodeKey,
  edge.targetNodeKey,
  edge.startSeconds,
  edge.endSeconds,
  edge.confidence,
  edge.evidence,
  edge.isReverse
FROM @edges AS edge
JOIN vkg.Node AS source
  ON source.nodeKey = edge.sourceNodeKey
JOIN vkg.Node AS target
  ON target.nodeKey = edge.targetNodeKey;

DECLARE @insertedEdges int = @@ROWCOUNT;
IF @insertedEdges <> (SELECT COUNT(*) FROM @edges)
  THROW 51000, 'Graph projection has unresolved edge endpoints', 1;

INSERT INTO vkg.ProjectionState (
  rootNodeKey, videoId, sceneId, metadataVersion, isReady, updatedAt
)
VALUES (@rootNodeKey, @videoId, @sceneId, @metadataVersion, 1, SYSUTCDATETIME());`;
const GET_SCENE_NODES_SQL = `
SELECT DISTINCT TOP (64) nodes.id, nodes.label, nodes.type
FROM (
  SELECT root.nodeKey AS id, root.displayName AS label, root.entityType AS type
  FROM vkg.Node AS root, vkg.ProjectionState AS ready
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND root.entityType = N'scene'
  UNION ALL
  SELECT occurrence.nodeKey AS id, occurrence.displayName AS label, occurrence.entityType AS type
  FROM vkg.Node AS root, vkg.ProjectionState AS ready, vkg.Edge AS membership, vkg.Node AS occurrence
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND membership.label = N'contains'
    AND membership.isReverse = 0
    AND occurrence.metadataVersion = @metadataVersion
    AND MATCH(root-(membership)->occurrence)
  UNION ALL
  SELECT actor.nodeKey AS id, actor.displayName AS label, actor.entityType AS type
  FROM vkg.Node AS root, vkg.ProjectionState AS ready, vkg.Edge AS membership, vkg.Node AS occurrence, vkg.Edge AS identityEdge, vkg.Node AS actor
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND membership.label = N'contains'
    AND membership.isReverse = 0
    AND identityEdge.label = N'identifiedAs'
    AND identityEdge.isReverse = 0
    AND occurrence.metadataVersion = @metadataVersion
    AND MATCH(root-(membership)->occurrence AND occurrence-(identityEdge)->actor)
) AS nodes
ORDER BY nodes.id;`;
const GET_SCENE_EDGES_SQL = `
SELECT DISTINCT TOP (128)
  edgeRows.id,
  edgeRows.source,
  edgeRows.target,
  edgeRows.label,
  edgeRows.startSeconds,
  edgeRows.endSeconds
FROM (
  SELECT
    membership.edgeKey AS id,
    membership.sourceNodeKey AS source,
    membership.targetNodeKey AS target,
    membership.label AS label,
    membership.startSeconds AS startSeconds,
    membership.endSeconds AS endSeconds
  FROM vkg.Node AS root, vkg.ProjectionState AS ready, vkg.Edge AS membership, vkg.Node AS occurrence
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND membership.label = N'contains'
    AND membership.isReverse = 0
    AND occurrence.metadataVersion = @metadataVersion
    AND MATCH(root-(membership)->occurrence)
  UNION ALL
  SELECT
    observed.edgeKey AS id,
    observed.sourceNodeKey AS source,
    observed.targetNodeKey AS target,
    observed.predicate AS label,
    observed.startSeconds AS startSeconds,
    observed.endSeconds AS endSeconds
  FROM vkg.Node AS root, vkg.ProjectionState AS ready, vkg.Edge AS membership, vkg.Node AS occurrence, vkg.Edge AS observed, vkg.Node AS target
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND membership.label = N'contains'
    AND membership.isReverse = 0
    AND observed.label = N'observed'
    AND observed.isReverse = 0
    AND occurrence.metadataVersion = @metadataVersion
    AND target.metadataVersion = @metadataVersion
    AND MATCH(root-(membership)->occurrence AND occurrence-(observed)->target)
  UNION ALL
  SELECT
    identityEdge.edgeKey AS id,
    identityEdge.sourceNodeKey AS source,
    identityEdge.targetNodeKey AS target,
    identityEdge.label AS label,
    identityEdge.startSeconds AS startSeconds,
    identityEdge.endSeconds AS endSeconds
  FROM vkg.Node AS root, vkg.ProjectionState AS ready, vkg.Edge AS membership, vkg.Node AS occurrence, vkg.Edge AS identityEdge, vkg.Node AS actor
  WHERE ready.rootNodeKey = root.nodeKey
    AND ready.isReady = 1
    AND ready.videoId = @videoId
    AND ready.sceneId = @sceneId
    AND ready.metadataVersion = @metadataVersion
    AND root.nodeKey = @rootNodeKey
    AND membership.label = N'contains'
    AND membership.isReverse = 0
    AND identityEdge.label = N'identifiedAs'
    AND identityEdge.isReverse = 0
    AND occurrence.metadataVersion = @metadataVersion
    AND MATCH(root-(membership)->occurrence AND occurrence-(identityEdge)->actor)
) AS edgeRows
ORDER BY edgeRows.id;`;

function stringParam(name: string, value: string, length: number | "max" = 4000): SqlParameter {
  return { name, type: "nvarchar", length, value };
}

function sqlErrorNumber(error: unknown): number | undefined {
  const value = error as SqlError | null;
  const candidates = [
    value?.number,
    value?.originalError?.info?.number,
    value?.precedingErrors?.find(item => Number.isFinite(item.number))?.number,
    Number(value?.statusCode),
    Number(value?.code)
  ];
  return candidates.find(candidate => Number.isFinite(candidate));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message :
    error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message : "";
}

function retryAfterMs(error: unknown): number {
  const message = errorMessage(error);
  const seconds = /retry after (\d+)\s*second/i.exec(message);
  if (seconds) return Math.min(10_000, Number(seconds[1]) * 1_000);
  const ms = /retry after (\d+)\s*ms/i.exec(message);
  if (ms) return Math.min(10_000, Number(ms[1]));
  return 1_000;
}

export function graphFailure(error: unknown): { statusCode: number; retryAfterMs: number; transient: boolean; auth: boolean } {
  const number = sqlErrorNumber(error);
  const message = errorMessage(error);
  const auth = number === 18456 || number === 401 || number === 403 ||
    /login failed|token-identified principal|principal .* could not be found|denied/i.test(message);
  const transient = number === 1205 || number === 1222 || number === 40501 || number === 429 || number === 51001;
  return {
    statusCode: Number.isFinite(number) ? Number(number) : 503,
    retryAfterMs: retryAfterMs(error),
    transient,
    auth
  };
}

function sqlError(error: unknown): SqlError {
  const value = error instanceof Error ? error : new Error("Unknown SQL error");
  return Object.assign(value, { graphSql: true }) as SqlError;
}

function projectionPayload(scene: SceneRecord): ProjectionPayload {
  const root = sceneVertexId(scene);
  const sharedNode = {
    videoId: scene.videoId,
    sceneId: scene.id,
    metadataVersion: scene.metadataVersion,
    startSeconds: scene.timecode.startSeconds,
    endSeconds: scene.timecode.endSeconds
  };
  const rootNode: ProjectionNode = {
    nodeKey: root,
    entityType: "scene",
    entityId: null,
    displayName: scene.caption,
    nameNormalized: null,
    identitySource: null,
    ...sharedNode
  };
  const nodes = new Map<string, ProjectionNode>([[rootNode.nodeKey, rootNode]]);
  const edges = new Map<string, ProjectionEdge>();
  for (const entity of scene.entities) {
    const nodeKey = occurrenceId(scene, entity.id);
    nodes.set(nodeKey, {
      nodeKey,
      entityType: entity.type,
      entityId: entity.id,
      displayName: entity.name,
      nameNormalized: normalizeLabel(entity.name),
      identitySource: entity.identitySource === "editor" ? "editor" : null,
      ...sharedNode
    });
    const containsEdge: ProjectionEdge = {
      edgeKey: `contains-${graphId(root, nodeKey)}`,
      sceneId: scene.id,
      videoId: scene.videoId,
      metadataVersion: scene.metadataVersion,
      label: "contains",
      predicate: null,
      sourceNodeKey: root,
      targetNodeKey: nodeKey,
      startSeconds: scene.timecode.startSeconds,
      endSeconds: scene.timecode.endSeconds,
      confidence: null,
      evidence: null,
      isReverse: false
    };
    edges.set(containsEdge.edgeKey, containsEdge);
    if (entity.type === "person" && entity.identitySource === "editor" && entity.actorName) {
      const normalized = normalizeLabel(entity.actorName);
      const actorNodeKey = `actor-${graphId(normalized)}`;
      nodes.set(actorNodeKey, {
        nodeKey: actorNodeKey,
        entityType: "actor",
        videoId: null,
        sceneId: null,
        metadataVersion: null,
        entityId: null,
        displayName: entity.actorName,
        nameNormalized: normalized,
        identitySource: "editor",
        startSeconds: null,
        endSeconds: null
      });
      const identityEdge: ProjectionEdge = {
        edgeKey: `identity-${graphId(nodeKey, actorNodeKey)}`,
        sceneId: scene.id,
        videoId: scene.videoId,
        metadataVersion: scene.metadataVersion,
        label: "identifiedAs",
        predicate: null,
        sourceNodeKey: nodeKey,
        targetNodeKey: actorNodeKey,
        startSeconds: scene.timecode.startSeconds,
        endSeconds: scene.timecode.endSeconds,
        confidence: null,
        evidence: null,
        isReverse: false
      };
      edges.set(identityEdge.edgeKey, identityEdge);
    }
  }
  for (const relation of scene.relations) {
    const sourceNodeKey = occurrenceId(scene, relation.subject);
    const targetNodeKey = occurrenceId(scene, relation.object);
    const edge: ProjectionEdge = {
      edgeKey: `observation-${graphId(root, relation.id)}`,
      sceneId: scene.id,
      videoId: scene.videoId,
      metadataVersion: scene.metadataVersion,
      label: "observed",
      predicate: relation.predicate,
      sourceNodeKey,
      targetNodeKey,
      startSeconds: relation.timecode.startSeconds,
      endSeconds: relation.timecode.endSeconds,
      confidence: relation.confidence,
      evidence: relation.evidence,
      isReverse: false
    };
    edges.set(edge.edgeKey, edge);
    if (symmetricPredicates.has(relation.predicate)) {
      const reverseEdge: ProjectionEdge = {
        ...edge,
        edgeKey: `observation-${graphId(root, relation.id, "reverse")}`,
        sourceNodeKey: targetNodeKey,
        targetNodeKey: sourceNodeKey,
        isReverse: true
      };
      edges.set(reverseEdge.edgeKey, reverseEdge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function projectionParameters(scene: SceneRecord): SqlParameter[] {
  return [
    stringParam("videoId", scene.videoId, 128),
    stringParam("sceneId", scene.id, 128),
    stringParam("metadataVersion", scene.metadataVersion, 64),
    stringParam("rootNodeKey", sceneVertexId(scene), 130),
    stringParam("data", JSON.stringify(projectionPayload(scene)), "max")
  ];
}

function sceneParameters(scene: SceneRecord): SqlParameter[] {
  return [
    stringParam("rootNodeKey", sceneVertexId(scene), 130),
    stringParam("videoId", scene.videoId, 128),
    stringParam("sceneId", scene.id, 128),
    stringParam("metadataVersion", scene.metadataVersion, 64)
  ];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createGraphSqlClient(
  config: Pick<Config, "sqlGraphServer" | "sqlGraphDatabase">,
  credential: TokenCredential
): GraphSqlClient {
  const require = createRequire(import.meta.url);
  const sql = require("mssql") as {
    ConnectionPool: new (options: Record<string, unknown>) => {
      connect(): Promise<unknown>;
      request(): {
        input(name: string, type: unknown, value: unknown): unknown;
        query<T>(statement: string): Promise<{ recordset: T[] }>;
      };
      close(): Promise<void>;
    };
    Request: new (transaction: unknown) => {
      input(name: string, type: unknown, value: unknown): unknown;
      query<T>(statement: string): Promise<{ recordset: T[] }>;
    };
    Transaction: new (pool: unknown) => {
      begin(level: unknown): Promise<void>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
    };
    NVarChar: (length?: number) => unknown;
    Int: unknown;
    Float: unknown;
    Bit: unknown;
    MAX: number;
    ISOLATION_LEVEL: { SERIALIZABLE: unknown };
  };

  const sqlType = (parameter: SqlParameter): unknown => {
    if (parameter.type === "int") return sql.Int;
    if (parameter.type === "float") return sql.Float;
    if (parameter.type === "bit") return sql.Bit;
    return sql.NVarChar(parameter.length === "max" ? sql.MAX : parameter.length ?? 4000);
  };

  const configure = async () => {
    const token = await credential.getToken(SQL_SCOPE);
    if (!token?.token) throw sqlError(Object.assign(new Error("Azure SQL access token unavailable"), { statusCode: 401 }));
    const pool = new sql.ConnectionPool({
      server: config.sqlGraphServer,
      database: config.sqlGraphDatabase,
      port: 1433,
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: SQL_REQUEST_TIMEOUT_MS,
      requestTimeout: SQL_REQUEST_TIMEOUT_MS,
      pool: { max: 1, min: 0, idleTimeoutMillis: 1_000 },
      authentication: { type: "azure-active-directory-access-token", options: { token: token.token } }
    });
    try {
      await pool.connect();
      return pool;
    } catch (error) {
      try { await pool.close(); } catch { console.error("[sql-graph] failed connection cleanup"); }
      throw sqlError(error);
    }
  };

  const applyInputs = (
    request: { input(name: string, type: unknown, value: unknown): unknown },
    parameters: readonly SqlParameter[]
  ): void => {
    for (const parameter of parameters) request.input(parameter.name, sqlType(parameter), parameter.value);
  };

  return {
    async query<T extends SqlRow>(
      statement: string,
      parameters: readonly SqlParameter[],
      transaction?: SqlTransaction
    ) {
      try {
        if (transaction) {
          const request = new sql.Request(transaction.id);
          applyInputs(request, parameters);
          return (await request.query<T>(statement)).recordset;
        }
        const pool = await configure();
        try {
          const request = pool.request();
          applyInputs(request, parameters);
          return (await request.query<T>(statement)).recordset;
        } finally {
          try { await pool.close(); } catch { console.error("[sql-graph] connection cleanup failed"); }
        }
      } catch (error) {
        throw sqlError(error);
      }
    },
    async transaction<T>(action: (transaction: SqlTransaction) => Promise<T>) {
      const pool = await configure();
      const transaction = new sql.Transaction(pool);
      let began = false;
      try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        began = true;
        const tx = { id: transaction };
        const result = await action(tx);
        await transaction.commit();
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try { await transaction.rollback(); } catch { console.error("[sql-graph] transaction rollback failed"); }
        }
        throw sqlError(error);
      } finally {
        try { await pool.close(); } catch { console.error("[sql-graph] connection cleanup failed"); }
      }
    },
    async close() { /* connections are per-operation */ }
  };
}

export class Graph {
  private readonly client: GraphSqlClient;

  constructor(
    private readonly config: Config,
    private readonly store: Pick<Store, "getScene">,
    credential?: TokenCredential,
    client?: GraphSqlClient,
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  ) {
    if (client) {
      this.client = client;
      return;
    }
    if (!credential) throw new Error("Azure credential required for graph access");
    this.client = createGraphSqlClient(config, credential);
  }

  private async withRetries<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < SQL_MAX_RETRIES; attempt++) {
      try {
        return await action();
      } catch (error) {
        const sql = error as SqlError;
        if (!sql.graphSql) throw error;
        const failure = graphFailure(sql);
        if (failure.auth) throw new GraphAccessError(failure.statusCode);
        if (failure.transient && attempt < SQL_MAX_RETRIES - 1) {
          await this.sleep(Math.min(10_000, failure.retryAfterMs * 2 ** attempt));
          continue;
        }
        throw Object.assign(new Error(`Graph request failed (${failure.statusCode})`),
          { statusCode: failure.transient ? 503 : failure.statusCode });
      }
    }
    throw new Error("Graph retry budget exhausted");
  }

  private async assertCurrent(scene: SceneRecord): Promise<void> {
    const active = await this.store.getScene(scene.videoId, scene.id);
    if (!active || active.metadataVersion !== scene.metadataVersion) {
      throw Object.assign(new Error("Projection version superseded"), { statusCode: 412 });
    }
  }

  async project(scene: SceneRecord): Promise<void> {
    await this.assertCurrent(scene);
    await this.withRetries(async () => this.client.transaction(async transaction => {
      await this.assertCurrent(scene);
      await this.client.query(LOCK_SQL, [stringParam("resource", `vkg:${scene.videoId}:${scene.id}`, 400)], transaction);
      await this.client.query(PROJECT_SQL, projectionParameters(scene), transaction);
      await this.assertCurrent(scene);
    }));
  }

  async match(scene: SceneRecord, plan: QueryPlan): Promise<Timecode[]> {
    const compiled = compileMatch(plan, scene);
    const rows = await this.withRetries(() => this.client.query(compiled.sql, compiled.parameters));
    return intervalsFromRows(rows.map(row => compiled.mapRow(row)), plan, scene.timecode);
  }

  async matchEvidence(scene: SceneRecord, plan: QueryPlan, proof: ActionEvidence): Promise<Timecode | undefined> {
    const interval = actionEvidenceInterval(scene, plan, proof);
    if (!interval) return undefined;
    const native = await this.getScene(scene);
    const root = sceneVertexId(scene);
    for (const relationId of proof.relationIds) {
      const recorded = scene.relations.find(relation => relation.id === relationId)!;
      const edge = native.edges.find(item => item.id === `observation-${graphId(root, relationId)}`);
      if (!edge || edge.source !== occurrenceId(scene, recorded.subject) ||
          edge.target !== occurrenceId(scene, recorded.object) || edge.label !== recorded.predicate ||
          edge.startSeconds !== recorded.timecode.startSeconds || edge.endSeconds !== recorded.timecode.endSeconds) {
        return undefined;
      }
    }
    return interval;
  }

  async getScene(scene: SceneRecord): Promise<MaterializedGraph> {
    await this.assertCurrent(scene);
    const parameters = sceneParameters(scene);
    const [nodeRows, edgeRows] = await Promise.all([
      this.withRetries(() => this.client.query(GET_SCENE_NODES_SQL, parameters)),
      this.withRetries(() => this.client.query(GET_SCENE_EDGES_SQL, parameters))
    ]);
    if (!nodeRows.length) throw Object.assign(new Error("Graph projection unavailable"), { statusCode: 409 });
    const result: MaterializedGraph = { nodes: [], edges: [] };
    for (const row of nodeRows) {
      const id = text(row.id);
      const label = text(row.label);
      const type = text(row.type);
      if (!id || !label || !type) throw new Error("Malformed native graph node result");
      result.nodes.push({ id, label, type });
    }
    const ids = new Set(result.nodes.map(node => node.id));
    for (const row of edgeRows) {
      const id = text(row.id);
      const source = text(row.source);
      const target = text(row.target);
      const label = text(row.label);
      const startSeconds = numeric(row.startSeconds);
      const endSeconds = numeric(row.endSeconds);
      if (!id || !source || !target || !ids.has(source) || !ids.has(target) || !label ||
          startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) {
        throw new Error("Malformed native graph edge result");
      }
      result.edges.push({ id, source, target, label, startSeconds, endSeconds });
    }
    return result;
  }

  async close(): Promise<void> { await this.client.close(); }
}
