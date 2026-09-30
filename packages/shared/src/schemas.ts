import { z } from "zod";
import type { Timecode } from "./index.js";
import { ValidationError } from "./types.js";
import { predicates } from "./ontology.js";
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
    type: entityType.optional(),
    actorName: actorName.optional()
  }).strict()).min(1).max(8),
  relations: z.array(z.object({
    subject: variable, predicate: z.enum(predicates), object: variable
  }).strict()).max(10),
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
  for (const entity of plan.entities) {
    if (entity.actorName && entity.type !== "person") {
      ctx.addIssue({ code: "custom", message: "Editorial actor constraints require person type" });
    }
  }
});

export const visualAnalysisSchema = z.object({
  caption: z.string().trim().min(1).max(4000),
  entities: z.array(z.object({
    id: identifierSchema, type: entityType, name: label, confidence
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
    if (entity.type === "person") {
      const category = entity.name.toLowerCase().trim();
      entity.name = ["person", "child", "adult"].includes(category) ? category : "person";
    }
  }
  return result.data;
}
