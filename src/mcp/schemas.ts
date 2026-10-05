import { z } from "zod";
import { confidenceSchema, desiredRequirementInput, memoryRecordStatusSchema, taskNoteTypeSchema } from "../task-state/schemas.js";
import { planStepInputSchema } from "../plan/schemas.js";

export const contextFindInput = z.object({
  query: z.string().min(1).max(2_000), scope: z.string().default("auto"),
  sources: z.array(z.enum(["code", "docs", "vault", "git"])).max(4).optional(), limit: z.number().int().min(1).max(20).default(8),
}).strict();
export const contextInspectInput = z.object({
  ref: z.string().min(1).max(4_000), view: z.enum(["content", "surrounding", "relations", "references", "summary", "diff", "file", "impact", "blame"]).default("content"),
}).strict();
const requirementInput = desiredRequirementInput.extend({
  statement: desiredRequirementInput.shape.statement.describe("Required. Observable requirement statement."),
  kind: desiredRequirementInput.shape.kind.describe("Required. Use behavior or constraint; a constraint requirement uses constraint."),
  priority: desiredRequirementInput.shape.priority.describe("Required. Use lowercase must or should; a MUST requirement uses must."),
  id: desiredRequirementInput.shape.id.describe("Optional. Omit for a new requirement; only reuse a server-issued R* ID from this memory's current specification."),
});
export const memoryInput = z.object({
  action: z.enum(["current", "note", "resolve", "spec_set"]).describe("Choose current, note, resolve, or spec_set. Every action uses the operator-selected active memory."),
  type: taskNoteTypeSchema.exclude(["hypothesis_rejected"]).optional(),
  text: z.string().trim().min(1).max(20_000).optional(),
  confidence: confidenceSchema.optional(),
  evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).optional(),
  repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional(),
  record_id: z.string().min(1).optional(), status: memoryRecordStatusSchema.optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
  summary: z.string().trim().min(1).max(50_000).optional().describe("Required for spec_set: summary of the complete desired specification."),
  requirements: z.array(requirementInput).min(1).max(500).optional().describe("Required for spec_set: complete desired list. Each item requires statement, kind, and priority; omit id for a new item."),
}).strict();

const memoryActions = {
  current: z.object({ action: z.literal("current") }).strict(),
  note: z.object({ action: z.literal("note"), type: taskNoteTypeSchema.exclude(["hypothesis_rejected"]), text: z.string().trim().min(1).max(20_000),
    confidence: confidenceSchema.default("medium"), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]),
    repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional() }).strict(),
  resolve: z.object({ action: z.literal("resolve"), record_id: z.string().min(1), status: memoryRecordStatusSchema,
    reason: z.string().trim().min(1).max(2_000), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]) }).strict(),
  spec_set: z.object({ action: z.literal("spec_set"), summary: z.string().trim().min(1).max(50_000),
    requirements: z.array(requirementInput).min(1).max(500) }).strict(),
};

export function parseMemoryAction(input: z.infer<typeof memoryInput>) {
  const action = memoryInput.shape.action.parse(input?.action);
  return memoryActions[action].parse(input);
}
export const planInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), steps: z.array(planStepInputSchema).min(1).max(50).describe("Required for create; no top-level title. Each step requires title, objective, acceptance, and verification"),
    exceptions: z.array(z.object({ requirement_id: z.string().regex(/^R[1-9][0-9]*$/), reason: z.string().trim().min(1).max(2_000) }).strict()).max(100).default([]) }).strict(),
  z.object({ action: z.literal("current") }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
  z.object({ action: z.literal("revise"), reason: z.string().trim().min(1).max(2_000), operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("replace_current"), step: planStepInputSchema }).strict(),
    z.object({ op: z.literal("append_steps"), steps: z.array(planStepInputSchema).min(1).max(49) }).strict(),
    z.object({ op: z.literal("drop_future") }).strict(),
    z.object({ op: z.literal("mark_write_not_needed"), repo: z.string().min(1), path: z.string().min(1), reason: z.string().trim().min(1).max(2_000) }).strict(),
    z.object({ op: z.literal("set_requirement_exception"), requirement_id: z.string().regex(/^R[1-9][0-9]*$/), reason: z.string().trim().min(1).max(2_000) }).strict(),
    z.object({ op: z.literal("allow_marker"), repo: z.string().min(1), path: z.string().min(1), marker: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(2_000) }).strict(),
  ])).min(1).max(50) }).strict(),
  z.object({ action: z.literal("suspend"), reason: z.string().trim().min(1).max(2_000).optional() }).strict(),
  z.object({ action: z.literal("reactivate") }).strict(),
  z.object({ action: z.literal("abandon"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

export type ContextFindInput = z.input<typeof contextFindInput>;
export type ContextInspectInput = z.input<typeof contextInspectInput>;
export type MemoryInput = z.input<typeof memoryInput>;
export type PlanInput = z.input<typeof planInput>;
