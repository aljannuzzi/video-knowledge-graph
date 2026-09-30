import type { QueryPlan, SceneEntity, SceneRelation, Timecode } from "./index.js";
import { normalizeLabel, observationEntityNames, observationEntityTypes, observationPredicates, symmetricPredicates } from "./ontology.js";

export function intersectIntervals(intervals: Timecode[]): Timecode | undefined {
  if (!intervals.length) return undefined;
  const startSeconds = Math.max(...intervals.map(value => value.startSeconds));
  const endSeconds = Math.min(...intervals.map(value => value.endSeconds));
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
      startSeconds < 0 || endSeconds <= startSeconds) return undefined;
  return { startSeconds, endSeconds };
}

export function entityMatches(entity: SceneEntity, expected: QueryPlan["entities"][number]): boolean {
  if (expected.type && !observationEntityTypes(expected.name, expected.type).includes(entity.type)) return false;
  if (expected.actorName) {
    return entity.type === "person" && entity.identitySource === "editor" &&
      !!entity.actorName && normalizeLabel(entity.actorName) === normalizeLabel(expected.actorName);
  }
  if (normalizeLabel(expected.name) === "person") return entity.type === "person";
  return observationEntityNames(expected.name).includes(normalizeLabel(entity.name));
}

export function canVerifyConjunction(plan: QueryPlan): boolean {
  if (plan.entities.length <= 1) return true;
  const observed = new Set(plan.relations.flatMap(relation => [relation.subject, relation.object]));
  for (const constraint of plan.semanticConstraints ?? []) observed.add(constraint.variable);
  return plan.entities.every(entity => observed.has(entity.variable));
}

// A deterministic reference evaluator for tests. Production uses the compiled
// native Gremlin traversal, then intersects the returned observed-edge intervals.
export function matchTemporal(
  plan: QueryPlan, entities: SceneEntity[], relations: SceneRelation[], bounds: Timecode
): Array<{ bindings: Record<string, string>; timecode: Timecode }> {
  if (!canVerifyConjunction(plan)) return [];
  const matches: Array<{ bindings: Record<string, string>; timecode: Timecode }> = [];
  const assigned: Record<string, string> = {};
  let visits = 0;
  const walkRelations = (index: number, timecode: Timecode): void => {
    if (++visits > 100_000 || matches.length >= 256) return;
    if (index === plan.relations.length) {
      matches.push({ bindings: { ...assigned }, timecode });
      return;
    }
    const query = plan.relations[index];
    for (const relation of relations) {
      const forward = relation.subject === assigned[query.subject] && relation.object === assigned[query.object];
      const backward = symmetricPredicates.has(query.predicate) &&
        relation.subject === assigned[query.object] && relation.object === assigned[query.subject];
      if ((!forward && !backward) || !observationPredicates(query.predicate).includes(relation.predicate)) continue;
      const common = intersectIntervals([timecode, relation.timecode]);
      if (common) walkRelations(index + 1, common);
    }
  };
  const walkEntities = (index: number): void => {
    if (++visits > 100_000 || matches.length >= 256) return;
    if (index === plan.entities.length) return walkRelations(0, bounds);
    const query = plan.entities[index];
    for (const entity of entities) {
      if (Object.values(assigned).includes(entity.id) || !entityMatches(entity, query)) continue;
      assigned[query.variable] = entity.id;
      walkEntities(index + 1);
      delete assigned[query.variable];
    }
  };
  walkEntities(0);
  return matches;
}
