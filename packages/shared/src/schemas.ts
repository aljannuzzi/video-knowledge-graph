import { z } from "zod";
import type { Timecode } from "./index.js";
import { ValidationError } from "./types.js";
import { canonicalEntityName, canonicalType, predicates } from "./ontology.js";
import { canVerifyConjunction } from "./temporal.js";

export const identifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const timecodeSchema = z.object({
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().positive()
}).strict().refine(value => value.endSeconds > value.startSeconds, "Interval must have positive duration");
const entityType = z.enum(["person", "animal", "object", "place", "action", "concept"]);
const label = z.string().trim().min(1).max(100);
const variable = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const confidence = z.number().finite().min(0).max(1);
const actorName = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);

export const searchRequestSchema = z.object({
  query: z.string().trim().min(3).max(2000),
  limit: z.number().int().min(1).max(20).optional()
}).strict();
export const identityRequestSchema = z.object({
  entityId: identifierSchema,
  actorName
}).strict();
export const clipRequestSchema = z.object({
  clips: z.array(z.object({
    sceneId: identifierSchema, videoId: identifierSchema, timecode: timecodeSchema
  }).strict()).min(1).max(30)
}).strict();

export const queryPlanSchema = z.object({
  entities: z.array(z.object({
    variable, name: label,
    type: entityType.nullish().transform(value => value ?? undefined),
    actorName: actorName.nullish().transform(value => value ?? undefined)
  }).strict()).min(1).max(8),
  relations: z.array(z.object({
    subject: variable, predicate: z.enum(predicates), object: variable
  }).strict()).max(10),
  semanticConstraints: z.array(z.object({
    variable, description: z.string().trim().min(3).max(500)
  }).strict()).max(4).optional(),
  explanation: z.string().min(1).max(2000)
}).strict().superRefine((plan, ctx) => {
  const names = new Set(plan.entities.map(entity => entity.variable));
  if (names.size !== plan.entities.length) ctx.addIssue({ code: "custom", message: "Duplicate variables" });
  if (!canVerifyConjunction(plan)) {
    ctx.addIssue({ code: "custom", message: "Every entity in a conjunction requires temporal relation evidence" });
  }
  for (const relation of plan.relations) {
    if (!names.has(relation.subject) || !names.has(relation.object) || relation.subject === relation.object) {
      ctx.addIssue({ code: "custom", message: "Relations must refer to distinct declared variables" });
    }
  }
  for (const constraint of plan.semanticConstraints ?? []) {
    if (!names.has(constraint.variable)) ctx.addIssue({ code: "custom", message: "Semantic constraint references an undeclared variable" });
  }
  for (const entity of plan.entities) {
    if (entity.actorName && entity.type !== "person") {
      ctx.addIssue({ code: "custom", message: "Editorial actor constraints require person type" });
    }
  }
}).transform(plan => ({
  ...plan,
  entities: plan.entities.map(entity => ({
    ...entity, name: canonicalEntityName(entity.name), type: canonicalType(entity.name, entity.type)
  }))
}));

export const queryPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entities", "relations", "semanticConstraints", "explanation"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["variable", "name", "type", "actorName"],
        properties: {
          variable: { type: "string" },
          name: { type: "string", description: "Open vocabulary singular English noun. Not restricted to examples." },
          type: { type: ["string", "null"], enum: ["person", "animal", "object", "place", "action", "concept", null] },
          actorName: { type: ["string", "null"], description: "Only an explicitly requested editorial actor name; otherwise null." }
        }
      }
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "predicate", "object"],
        properties: {
          subject: { type: "string" },
          predicate: { type: "string", enum: predicates },
          object: { type: "string" }
        }
      }
    },
    semanticConstraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["variable", "description"],
        properties: {
          variable: { type: "string" },
          description: { type: "string", description: "Requested action not representable by existing predicates, anchored to this entity variable." }
        }
      }
    },
    explanation: { type: "string" }
  }
};

export const actionEvidenceSchema = z.object({
  matched: z.boolean(),
  entityBindings: z.array(z.object({ variable, entityId: identifierSchema }).strict()).max(8),
  relationIds: z.array(identifierSchema).max(12),
  explanation: z.string().trim().min(1).max(2000)
}).strict().superRefine((value, ctx) => {
  if (value.matched && (!value.entityBindings.length || !value.relationIds.length)) {
    ctx.addIssue({ code: "custom", message: "A semantic match requires anchored entities and temporal evidence" });
  }
  if (!value.matched && (value.entityBindings.length || value.relationIds.length)) {
    ctx.addIssue({ code: "custom", message: "A rejected match cannot claim evidence" });
  }
});

export const actionEvidenceJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["matched", "entityBindings", "relationIds", "explanation"],
  properties: {
    matched: { type: "boolean" },
    entityBindings: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["variable", "entityId"],
        properties: { variable: { type: "string" }, entityId: { type: "string" } }
      }
    },
    relationIds: { type: "array", items: { type: "string" } },
    explanation: { type: "string" }
  }
};

export const visualAnalysisSchema = z.object({
  caption: z.string().trim().min(1).max(4000),
  entities: z.array(z.object({
    id: identifierSchema,
    type: z.enum(["person", "animal", "object", "place", "action", "concept", "adult", "child"])
      .transform(type => type === "adult" || type === "child" ? "person" as const : type),
    name: label, confidence
  }).strict()).max(24),
  relations: z.array(z.object({
    id: identifierSchema, subject: identifierSchema, predicate: z.enum(predicates), object: identifierSchema,
    confidence, timecode: timecodeSchema, evidence: z.string().trim().min(1).max(1000)
  }).strict()).max(40),
  tags: z.array(label).max(20)
}).strict().superRefine((analysis, ctx) => {
  const ids = new Set(analysis.entities.map(entity => entity.id));
  if (ids.size !== analysis.entities.length) ctx.addIssue({ code: "custom", message: "Duplicate entity identifiers" });
  const relations = new Set(analysis.relations.map(relation => relation.id));
  if (relations.size !== analysis.relations.length) ctx.addIssue({ code: "custom", message: "Duplicate relation identifiers" });
  for (const relation of analysis.relations) {
    if (!ids.has(relation.subject) || !ids.has(relation.object) || relation.subject === relation.object) {
      ctx.addIssue({ code: "custom", message: "Dangling or self-referential relation" });
    }
  }
});

export const visualAnalysisJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["caption", "entities", "relations", "tags"],
  properties: {
    caption: { type: "string" },
    entities: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["id", "type", "name", "confidence"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["person", "animal", "object", "place", "action", "concept"] },
          name: { type: "string", description: "Singular canonical English noun; adult and child are names, not types." },
          confidence: { type: "number" }
        }
      }
    },
    relations: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["id", "subject", "predicate", "object", "confidence", "timecode", "evidence"],
        properties: {
          id: { type: "string" }, subject: { type: "string" }, object: { type: "string" },
          predicate: { type: "string", enum: predicates },
          confidence: { type: "number" },
          timecode: {
            type: "object", additionalProperties: false,
            required: ["startSeconds", "endSeconds"],
            properties: { startSeconds: { type: "number" }, endSeconds: { type: "number" } }
          },
          evidence: { type: "string" }
        }
      }
    },
    tags: { type: "array", items: { type: "string" } }
  }
};

export function visualSchemaForWindow(frameSeconds: number[], bounds: Timecode) {
  const starts = [...new Set(frameSeconds)].sort((a, b) => a - b);
  timecodeSchema.parse(bounds);
  if (!starts.length || starts.some(t => !Number.isFinite(t) || t < bounds.startSeconds || t >= bounds.endSeconds)) {
    throw new ValidationError("Invalid frame timestamps for visual schema");
  }
  const relationSchema = visualAnalysisJsonSchema.properties.relations;
  return {
    ...visualAnalysisJsonSchema,
    properties: {
      ...visualAnalysisJsonSchema.properties,
      relations: {
        ...relationSchema,
        items: {
          ...relationSchema.items,
          properties: {
            ...relationSchema.items.properties,
            timecode: {
              anyOf: starts.map(start => ({
                type: "object", additionalProperties: false, required: ["startSeconds", "endSeconds"],
                properties: {
                  startSeconds: { type: "number", enum: [start] },
                  endSeconds: { type: "number", enum: [...starts.filter(end => end > start), bounds.endSeconds] }
                }
              }))
            }
          }
        }
      }
    }
  };
}

export type VisualAnalysis = z.infer<typeof visualAnalysisSchema>;
export function validateVisualAnalysis(value: unknown, bounds: Timecode): VisualAnalysis {
  const parsedBounds = timecodeSchema.parse(bounds);
  const result = visualAnalysisSchema.safeParse(value);
  if (!result.success) throw new ValidationError("Vision response does not conform to the visual metadata schema");
  for (const relation of result.data.relations) {
    if (relation.timecode.startSeconds < parsedBounds.startSeconds ||
        relation.timecode.endSeconds > parsedBounds.endSeconds) {
      throw new ValidationError("Vision relation is outside the sampled scene interval");
    }
  }
  // Even an instruction-following vision model is not an identity authority.
  // Discard visual names for people; actor identities enter only via editor API.
  for (const entity of result.data.entities) {
    entity.name = canonicalEntityName(entity.name);
    entity.type = canonicalType(entity.name, entity.type) ?? entity.type;
    if (entity.type === "person") {
      const category = entity.name.toLowerCase().trim();
      entity.name = ["person", "child", "adult"].includes(category) ? category : "person";
    }
  }
  return result.data;
}
