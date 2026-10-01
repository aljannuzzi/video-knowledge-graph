import type { TokenCredential } from "@azure/core-auth";
import type { Config } from "./types.js";
import { createGraphSqlClient, type GraphSqlClient } from "./graph.js";

export const graphSchemaNames = {
  schema: "vkg",
  nodeTable: "Node",
  edgeTable: "Edge",
  projectionStateTable: "ProjectionState"
} as const;

export const graphSchemaSql = `
IF SCHEMA_ID(N'vkg') IS NULL
  EXEC(N'CREATE SCHEMA vkg AUTHORIZATION dbo;');

IF OBJECT_ID(N'vkg.Node', N'U') IS NULL
BEGIN
  CREATE TABLE vkg.Node (
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
  ) AS NODE;
  CREATE UNIQUE INDEX UX_vkg_Node_nodeKey ON vkg.Node(nodeKey);
  CREATE INDEX IX_vkg_Node_sceneVersion ON vkg.Node(videoId, sceneId, metadataVersion, entityType);
  CREATE INDEX IX_vkg_Node_lookup ON vkg.Node(nameNormalized, identitySource, entityType);
END;

IF OBJECT_ID(N'vkg.Edge', N'U') IS NULL
BEGIN
  CREATE TABLE vkg.Edge (
    edgeKey NVARCHAR(160) NOT NULL,
    sceneId NVARCHAR(128) NULL,
    videoId NVARCHAR(128) NULL,
    metadataVersion NVARCHAR(64) NULL,
    label NVARCHAR(32) NOT NULL,
    predicate NVARCHAR(64) NULL,
    sourceNodeKey NVARCHAR(130) NOT NULL,
    targetNodeKey NVARCHAR(130) NOT NULL,
    startSeconds FLOAT NOT NULL,
    endSeconds FLOAT NOT NULL,
    confidence FLOAT NULL,
    evidence NVARCHAR(1000) NULL,
    isReverse BIT NOT NULL CONSTRAINT DF_vkg_Edge_isReverse DEFAULT 0
  ) AS EDGE;
  CREATE UNIQUE INDEX UX_vkg_Edge_edgeKey ON vkg.Edge(edgeKey);
  CREATE INDEX IX_vkg_Edge_sceneVersion ON vkg.Edge(videoId, sceneId, metadataVersion, label, predicate, isReverse);
  CREATE INDEX IX_vkg_Edge_endpoints ON vkg.Edge(sourceNodeKey, targetNodeKey, label, isReverse);
END;

IF OBJECT_ID(N'vkg.ProjectionState', N'U') IS NULL
BEGIN
  CREATE TABLE vkg.ProjectionState (
    rootNodeKey NVARCHAR(130) NOT NULL CONSTRAINT PK_vkg_ProjectionState PRIMARY KEY,
    videoId NVARCHAR(128) NOT NULL,
    sceneId NVARCHAR(128) NOT NULL,
    metadataVersion NVARCHAR(64) NOT NULL,
    isReady BIT NOT NULL,
    updatedAt DATETIME2(3) NOT NULL,
    CONSTRAINT UQ_vkg_ProjectionState_sceneVersion UNIQUE(videoId, sceneId, metadataVersion)
  );
  CREATE INDEX IX_vkg_ProjectionState_lookup ON vkg.ProjectionState(videoId, sceneId, metadataVersion, isReady);
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID(N'vkg.Node') AND is_node = 1)
  OR NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID(N'vkg.Edge') AND is_edge = 1)
  THROW 51000, 'Existing graph objects are not native graph tables', 1;
IF COL_LENGTH(N'vkg.Node', N'displayName') < 8000
  ALTER TABLE vkg.Node ALTER COLUMN displayName NVARCHAR(4000) NOT NULL;
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'vkg.Node')
    AND name IN (N'videoId', N'sceneId', N'metadataVersion', N'entityId', N'startSeconds', N'endSeconds')
    AND is_nullable = 0
)
  THROW 51000, 'Existing graph schema requires an explicit nullable-node migration', 1;`;

export function createGraphRuntimeGrantSql(input: { principalName: string; principalClientId: string }): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(input.principalName) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.principalClientId)) {
    throw new Error("Invalid SQL bootstrap principal configuration");
  }
  const principal = `[${input.principalName}]`;
  return `
DECLARE @sid binary(16) = CONVERT(binary(16), CONVERT(uniqueidentifier, '${input.principalClientId}'));
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${input.principalName}' AND (sid <> @sid OR type <> 'E'))
  THROW 51000, 'Existing runtime database user does not match the configured identity', 1;
IF DATABASE_PRINCIPAL_ID(N'${input.principalName}') IS NULL
BEGIN
  DECLARE @create nvarchar(max) = N'CREATE USER ${principal} WITH SID = ' +
    CONVERT(nvarchar(34), @sid, 1) + N', TYPE = E;';
  EXEC sys.sp_executesql @create;
END;
IF IS_ROLEMEMBER('db_owner', N'${input.principalName}') = 1
  THROW 51000, 'Runtime identity must not be a database owner', 1;
GRANT CONNECT TO ${principal};
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::vkg TO ${principal};`.trim();
}

export async function initializeGraphSchema(
  config: Pick<Config, "sqlGraphServer" | "sqlGraphDatabase">,
  credential: TokenCredential,
  client?: GraphSqlClient
): Promise<void> {
  const sql = client ?? createGraphSqlClient(config, credential);
  try {
    await sql.query(graphSchemaSql, []);
  } finally {
    await sql.close();
  }
}
