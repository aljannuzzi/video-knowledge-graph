import { createHash } from "node:crypto";
import type { QueryPlan, Timecode } from "./index.js";
import { normalizeLabel, observationEntityNames, observationEntityTypes, observationPredicates } from "./ontology.js";
import { queryPlanSchema } from "./schemas.js";
import { canVerifyConjunction, intersectIntervals } from "./temporal.js";
import type { SceneRecord } from "./types.js";

export type SqlParameter = {
  name: string;
  type: "nvarchar" | "int" | "float" | "bit";
  value: string | number | boolean;
  length?: number | "max";
};

type MatchRow = Record<string, unknown>;

export function graphId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function sceneVertexId(scene: Pick<SceneRecord, "videoId" | "id" | "metadataVersion">): string {
  return `scene-${graphId(scene.videoId, scene.id, scene.metadataVersion)}`;
}
export function occurrenceId(scene: SceneRecord, entityId: string): string {
  return `occurrence-${graphId(scene.videoId, scene.id, scene.metadataVersion, entityId)}`;
}

export function compileMatch(planInput: QueryPlan, scene: SceneRecord): {
  sql: string;
  script: string;
  parameters: SqlParameter[];
  bindings: Record<string, unknown>;
  mapRow: (row: MatchRow) => MatchRow;
} {
  const plan = queryPlanSchema.parse(planInput);
  const bindings: Record<string, unknown> = {
    rootId: sceneVertexId(scene),
    videoId: scene.videoId,
    sceneId: scene.id,
    version: scene.metadataVersion,
    ready: true
  };
  const parameters: SqlParameter[] = [
    { name: "rootId", type: "nvarchar", value: sceneVertexId(scene), length: 130 },
    { name: "videoId", type: "nvarchar", value: scene.videoId, length: 128 },
    { name: "sceneId", type: "nvarchar", value: scene.id, length: 128 },
    { name: "version", type: "nvarchar", value: scene.metadataVersion, length: 64 },
    { name: "ready", type: "bit", value: true }
  ];
  const from = ["vkg.Node AS root", "vkg.ProjectionState AS ready"];
  const where = [
    "ready.rootNodeKey = root.nodeKey",
    "ready.isReady = @ready",
    "ready.videoId = @videoId",
    "ready.sceneId = @sceneId",
    "ready.metadataVersion = @version",
    "root.nodeKey = @rootId",
    "root.entityType = N'scene'",
    "root.videoId = @videoId",
    "root.sceneId = @sceneId",
    "root.metadataVersion = @version"
  ];
  const select: string[] = [];
  const patterns: string[] = [];
  const variables = new Map(plan.entities.map((entity, index) => [entity.variable, `v${index}`]));
  plan.entities.forEach((entity, index) => {
    const occurrence = `v${index}`;
    const contains = `contains${index}`;
    from.push(`vkg.Edge AS ${contains}`, `vkg.Node AS ${occurrence}`);
    patterns.push(`root-(${contains})->${occurrence}`);
    where.push(
      `${contains}.label = N'contains'`,
      `${contains}.isReverse = 0`,
      `${contains}.metadataVersion = @version`,
      `${occurrence}.videoId = @videoId`,
      `${occurrence}.sceneId = @sceneId`,
      `${occurrence}.metadataVersion = @version`
    );
    if (entity.type) {
      const types = observationEntityTypes(entity.name, entity.type);
      bindings[`type${index}`] = [...types];
      parameters.push({ name: `type${index}`, type: "nvarchar", value: JSON.stringify(types), length: "max" });
      where.push(`EXISTS (
        SELECT 1
        FROM OPENJSON(@type${index}) WITH (value NVARCHAR(32) '$') AS allowed
        WHERE allowed.value = ${occurrence}.entityType
      )`);
    }
    if (entity.actorName) {
      from.push(`vkg.Edge AS identity${index}`, `vkg.Node AS actor${index}`);
      patterns.push(`${occurrence}-(identity${index})->actor${index}`);
      bindings[`actor${index}`] = normalizeLabel(entity.actorName);
      parameters.push({ name: `actor${index}`, type: "nvarchar", value: normalizeLabel(entity.actorName), length: 200 });
      where.push(
        `${occurrence}.entityType = N'person'`,
        `${occurrence}.identitySource = N'editor'`,
        `identity${index}.label = N'identifiedAs'`,
        `identity${index}.isReverse = 0`,
        `identity${index}.videoId = @videoId`,
        `identity${index}.sceneId = @sceneId`,
        `identity${index}.metadataVersion = @version`,
        `actor${index}.entityType = N'actor'`,
        `actor${index}.nameNormalized = @actor${index}`
      );
    } else if (normalizeLabel(entity.name) === "person") {
      where.push(`${occurrence}.entityType = N'person'`);
    } else {
      const names = observationEntityNames(entity.name);
      bindings[`name${index}`] = [...names];
      parameters.push({ name: `name${index}`, type: "nvarchar", value: JSON.stringify(names), length: "max" });
      where.push(`EXISTS (
        SELECT 1
        FROM OPENJSON(@name${index}) WITH (value NVARCHAR(200) '$') AS allowed
        WHERE allowed.value = ${occurrence}.nameNormalized
      )`);
    }
    for (let other = 0; other < index; other++) where.push(`${occurrence}.nodeKey <> v${other}.nodeKey`);
    select.push(`${occurrence}.entityId AS entity${index}`);
  });
  plan.relations.forEach((relation, index) => {
    const edge = `e${index}`;
    const accepted = observationPredicates(relation.predicate);
    bindings[`predicate${index}`] = [...accepted];
    parameters.push({ name: `predicate${index}`, type: "nvarchar", value: JSON.stringify(accepted), length: "max" });
    from.push(`vkg.Edge AS ${edge}`);
    patterns.push(`${variables.get(relation.subject)}-(${edge})->${variables.get(relation.object)}`);
    where.push(
      `${edge}.label = N'observed'`,
      `${edge}.videoId = @videoId`,
      `${edge}.sceneId = @sceneId`,
      `${edge}.metadataVersion = @version`,
      `EXISTS (
        SELECT 1
        FROM OPENJSON(@predicate${index}) WITH (value NVARCHAR(64) '$') AS allowed
        WHERE allowed.value = ${edge}.predicate
      )`
    );
    select.push(
      `${edge}.edgeKey AS relation${index}_id`,
      `${edge}.startSeconds AS relation${index}_startSeconds`,
      `${edge}.endSeconds AS relation${index}_endSeconds`
    );
  });
  const sql = `SELECT DISTINCT TOP (256)
  ${select.join(",\n  ")}
FROM ${from.join(",\n     ")}
WHERE ${where.join("\n  AND ")}
  AND MATCH(${patterns.join(" AND ")})`;
  const mapRow = (row: MatchRow): MatchRow => {
    const record: MatchRow = {};
    plan.entities.forEach((_, index) => { record[`entity${index}`] = row[`entity${index}`]; });
    plan.relations.forEach((_, index) => {
      record[`relation${index}`] = {
        id: row[`relation${index}_id`],
        startSeconds: row[`relation${index}_startSeconds`],
        endSeconds: row[`relation${index}_endSeconds`]
      };
    });
    return record;
  };
  return { sql, script: sql, parameters, bindings, mapRow };
}

export function intervalsFromRows(rows: unknown[], plan: QueryPlan, bounds: Timecode): Timecode[] {
  if (!canVerifyConjunction(plan)) return [];
  const result: Timecode[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (plan.entities.some((_, index) => typeof record[`entity${index}`] !== "string")) continue;
    const values: Timecode[] = [bounds];
    let valid = true;
    for (let index = 0; index < plan.relations.length; index++) {
      const edge = record[`relation${index}`] as Partial<Timecode> | undefined;
      if (!edge || typeof edge.startSeconds !== "number" || typeof edge.endSeconds !== "number" ||
          !Number.isFinite(edge.startSeconds) || !Number.isFinite(edge.endSeconds) ||
          edge.startSeconds < bounds.startSeconds || edge.endSeconds > bounds.endSeconds ||
          edge.endSeconds <= edge.startSeconds) { valid = false; break; }
      values.push({ startSeconds: edge.startSeconds, endSeconds: edge.endSeconds });
    }
    const common = valid ? intersectIntervals(values) : undefined;
    if (common) result.push(common);
  }
  return result.sort((a, b) => a.startSeconds - b.startSeconds || b.endSeconds - a.endSeconds);
}
