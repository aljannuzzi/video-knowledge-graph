import type { ActionEvidence, QueryPlan, SceneMetadata, Timecode } from "./index.js";
import { observationPredicates, symmetricPredicates } from "./ontology.js";
import { entityMatches, intersectIntervals } from "./temporal.js";

export function actionEvidenceInterval(
  scene: SceneMetadata, plan: QueryPlan, proof: ActionEvidence
): Timecode | undefined {
  if (!proof.matched || !proof.relationIds.length || !plan.semanticConstraints?.length) return undefined;
  if (proof.entityBindings.length !== plan.entities.length ||
      new Set(proof.entityBindings.map(b => b.variable)).size !== plan.entities.length ||
      new Set(proof.entityBindings.map(b => b.entityId)).size !== plan.entities.length ||
      new Set(proof.relationIds).size !== proof.relationIds.length) return undefined;
  const bindings = new Map(proof.entityBindings.map(b => [b.variable, b.entityId]));
  for (const expected of plan.entities) {
    const entity = scene.entities.find(e => e.id === bindings.get(expected.variable));
    if (!entity || !entityMatches(entity, expected)) return undefined;
  }
  const edges = scene.relations.filter(r => proof.relationIds.includes(r.id));
  if (edges.length !== proof.relationIds.length || edges.some(edge =>
    edge.timecode.startSeconds < scene.timecode.startSeconds ||
    edge.timecode.endSeconds > scene.timecode.endSeconds ||
    edge.timecode.endSeconds <= edge.timecode.startSeconds)) return undefined;
  const common = intersectIntervals([scene.timecode, ...edges.map(edge => edge.timecode)]);
  if (!common) return undefined;
  for (const query of plan.relations) {
    if (!edges.some(edge => observationPredicates(query.predicate).includes(edge.predicate) && (
      (edge.subject === bindings.get(query.subject) && edge.object === bindings.get(query.object)) ||
      (symmetricPredicates.has(query.predicate) && edge.subject === bindings.get(query.object) && edge.object === bindings.get(query.subject))
    ))) return undefined;
  }
  // A cited operation on one dog must not justify the same action on another dog.
  const seen = new Set([proof.entityBindings[0].entityId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if (seen.has(edge.subject) || seen.has(edge.object)) {
        if (!seen.has(edge.subject) || !seen.has(edge.object)) grew = true;
        seen.add(edge.subject);
        seen.add(edge.object);
      }
    }
  }
  if (edges.some(edge => !seen.has(edge.subject) || !seen.has(edge.object)) ||
      proof.entityBindings.some(binding => !seen.has(binding.entityId))) return undefined;
  if (plan.semanticConstraints.some(constraint => !bindings.has(constraint.variable) ||
    !edges.some(edge => edge.subject === bindings.get(constraint.variable) || edge.object === bindings.get(constraint.variable)))) return undefined;
  return common;
}
