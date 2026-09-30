import { createHash } from "node:crypto";
import type { QueryPlan, Timecode } from "./index.js";
import { normalizeLabel, observationEntityNames, observationEntityTypes, observationPredicates, symmetricPredicates } from "./ontology.js";
import { queryPlanSchema } from "./schemas.js";
import { canVerifyConjunction, intersectIntervals } from "./temporal.js";
import type { SceneRecord } from "./types.js";

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
  script: string; bindings: Record<string, unknown>
} {
  const plan = queryPlanSchema.parse(planInput);
  const bindings: Record<string, unknown> = {
    pk: scene.videoId, rootId: sceneVertexId(scene), version: scene.metadataVersion
  };
  let script = "g.V([pk,rootId]).hasLabel('Scene').has('metadataVersion',version).as('root')";
  const variables = new Map(plan.entities.map((entity, index) => [entity.variable, `v${index}`]));
  plan.entities.forEach((entity, index) => {
    script += ".select('root').out('contains').hasLabel('Occurrence')";
    if (entity.type) {
      const types = observationEntityTypes(entity.name, entity.type);
      bindings[`type${index}`] = types.length === 1 ? types[0] : types;
      script += `.has('entityType',${types.length === 1 ? `type${index}` : `within(type${index})`})`;
    }
    if (entity.actorName) {
      bindings[`actor${index}`] = normalizeLabel(entity.actorName);
      script += `.has('identitySource','editor').where(__.out('identifiedAs').hasLabel('Actor').has('nameNormalized',actor${index}))`;
    } else if (normalizeLabel(entity.name) === "person") {
      script += ".has('entityType','person')";
    } else {
      const names = observationEntityNames(entity.name);
      bindings[`name${index}`] = names.length === 1 ? names[0] : names;
      script += `.has('nameNormalized',${names.length === 1 ? `name${index}` : `within(name${index})`})`;
    }
    for (let other = 0; other < index; other++) script += `.where(neq('v${other}'))`;
    script += `.as('v${index}').limit(256)`;
  });
  plan.relations.forEach((relation, index) => {
    const accepted = observationPredicates(relation.predicate);
    bindings[`predicate${index}`] = accepted.length === 1 ? accepted[0] : accepted;
    const predicateFilter = accepted.length === 1 ? `predicate${index}` : `within(predicate${index})`;
    const symmetric = symmetricPredicates.has(relation.predicate);
    script += `.select('${variables.get(relation.subject)}').${symmetric ? "bothE" : "outE"}('observed')` +
      `.has('metadataVersion',version).has('predicate',${predicateFilter}).as('r${index}')` +
      `.${symmetric ? "otherV" : "inV"}().where(eq('${variables.get(relation.object)}')).limit(256)`;
  });
  const keys = [
    ...plan.entities.map((_, index) => `'entity${index}'`),
    ...plan.relations.map((_, index) => `'relation${index}'`)
  ];
  // Limit bounds Cartesian work/output; retrieval is explicitly non-exhaustive.
  script += `.limit(256).project(${keys.join(",")})`;
  plan.entities.forEach((_, index) => { script += `.by(__.select('v${index}').values('entityId'))`; });
  plan.relations.forEach((_, index) => {
    script += `.by(__.select('r${index}').project('id','startSeconds','endSeconds')` +
      ".by(id()).by('startSeconds').by('endSeconds'))";
  });
  return { script, bindings };
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
