import type { SceneEntity } from "./index.js";

export const predicates = [
  "sitting_on", "standing_on", "lying_on", "near", "next_to", "holding", "wearing",
  "looking_at", "walking_toward", "walking_with", "riding", "inside", "in_front_of",
  "behind", "touching", "using", "carrying", "interacting_with", "talking_to", "sitting_at", "decorated_with", "eating", "drinking",
  "running_with", "playing_with", "on", "under", "above", "facing"
] as const;
export const symmetricPredicates = new Set<string>(["near", "next_to", "touching", "interacting_with", "talking_to", "walking_with", "running_with", "playing_with"]);

export function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/g, " ");
}

const knownTypes: Record<string, SceneEntity["type"]> = {
  person: "person", adult: "person", child: "person",
  cat: "animal", dog: "animal", bird: "animal", horse: "animal",
  sofa: "object", chair: "object", table: "object", candle: "object", plate: "object",
  window: "object", rug: "object", "christmas decoration": "object", "christmas tree": "object"
};
export function canonicalType(name: string, proposed?: SceneEntity["type"]): SceneEntity["type"] | undefined {
  const key = normalizeLabel(name);
  return Object.hasOwn(knownTypes, key) ? knownTypes[key] : proposed;
}

export const ontologyPrompt = `Use singular, lowercase, plain English canonical nouns for entities
(person, sofa, dog, chair, table), regardless of input language. Couch is sofa.
Use ONLY these relationship predicates: ${predicates.join(", ")}.
Entity types must be consistent: person/adult/child are person; cat/dog/bird/horse are animal,
not object. Sofa/table/chair and Christmas decorations are object.
Choose the most specific supported predicate; do not invent predicates or infer unstated relationships.
People are anonymous occurrences with type person and name person, child, or adult.
Use child or adult only when the broad visual category is clear; do not estimate exact age.
Generic person queries include these broad categories. Do not identify, recognize, or infer real identities.
Use sitting_at for people seated at a table, not sitting_on the table.
Use decorated_with from a table to christmas decoration when the decoration is visibly on that table.
Use christmas decoration as the canonical noun for a visibly Christmas-themed decorative arrangement,
including a festive table garland or centerpiece; do not infer Christmas from ordinary candles alone.
Use talking_to only for visually supported apparent conversation (facing, mouth/gesture evidence);
it is not proof of audible dialogue. Do not substitute mere proximity for conversation.
Actions may be entity nouns (walking, talking), but actor names NEVER come from images.`;
