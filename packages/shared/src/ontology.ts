import type { SceneEntity } from "./index.js";

export const predicates = [
  "sitting_on", "standing_on", "lying_on", "near", "next_to", "holding", "wearing",
  "looking_at", "walking_toward", "walking_with", "riding", "inside", "in_front_of",
  "behind", "touching", "using", "carrying", "interacting_with", "talking_to", "sitting_at", "decorated_with", "eating", "drinking",
  "running_with", "playing_with", "on", "under", "above", "facing"
] as const;
export const symmetricPredicates = new Set<string>(["near", "next_to", "touching", "interacting_with", "talking_to", "walking_with", "running_with", "playing_with"]);

// Entailment is one-way: a posture on a surface proves "on", not the reverse.
export function observationPredicates(requested: string): readonly string[] {
  return requested === "on" ? ["on", "sitting_on", "standing_on", "lying_on"] : [requested];
}

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

export const queryOntologyPrompt = `Entity.name is an OPEN string vocabulary, not an enum:
any requested noun is allowed, even if absent from the catalog. Use singular English canonical nouns.
Examples are NOT a list of allowed names. gato -> cat, cachorro -> dog, pessoa -> person, crianca -> child,
sofa/sofá/couch -> sofa. Entity.type is a separate category: person, animal, object, place, action, concept.
Cat/dog are animal; sofa/table/chair are object; person/adult/child are person.
Predicates alone use the CLOSED list: ${predicates.join(", ")}.
Use exactly the relation requested; never assume an unstated posture or require an explicit verb.
Prepositions ARE relationships: "X no sofa", "X sobre o sofa", "X on the couch" -> X on sofa.
"X sentado no sofa" -> sitting_on; "X deitado no sofa" -> lying_on;
"X em pe no sofa" -> standing_on; "X ao lado do sofa" -> next_to.
A generic on query is checked against on OR sitting_on OR standing_on OR lying_on observations by
the graph engine. Do not encode those alternatives as multiple simultaneous relations.
"pessoa e gato no sofa" distributes the location to both subjects, using ONE sofa variable:
person on sofa AND cat on sofa. It is NOT a bare noun list. Do not add a person-cat relation.
"gato no sofa" needs only cat and sofa; never add a person because one may exist in the catalog.
"pessoa no sofa" needs only person and sofa.
"pessoas sentadas a mesa com enfeites de natal" uses sitting_at table and table decorated_with christmas decoration.
"ator conversando com crianca" uses talking_to, not mere proximity. Named actors require actorName
and type person, matched only to editorial identity; names do not come from visual recognition.
Use null for absent actorName and unknown type. Generic person includes anonymous adult and child.
All predicates have subject-to-object direction; talking_to/next_to are symmetric.
Do not weaken explicit constraints. sitting_on does NOT accept merely on or lying_on observations.`;

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
