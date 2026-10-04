import { z } from "zod";
import { confidenceSchema, memoryRecordStatusSchema, taskNoteTypeSchema } from "../task-state/schemas.js";
import { planStepInputSchema } from "../plan/schemas.js";

export const contextFindInput = z.object({
  query: z.string().min(1).max(2_000), scope: z.string().default("auto"),
  sources: z.array(z.enum(["code", "docs", "vault", "git"])).max(4).optional(), limit: z.number().int().min(1).max(20).default(8),
});
export const contextInspectInput = z.object({
  ref: z.string().min(1).max(4_000), view: z.enum(["content", "surrounding", "relations", "references", "summary", "diff", "file", "impact", "blame"]).default("content"),
});
const requirementInput = z.object({ statement: z.string().trim().min(1).max(10_000), kind: z.enum(["behavior", "constraint"]), priority: z.enum(["must", "should"]) });
const specPatchOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), requirement: requirementInput }),
  z.object({ op: z.literal("update"), id: z.string().regex(/^R[1-9][0-9]*$/), requirement: requirementInput.partial() }),
  z.object({ op: z.literal("remove"), id: z.string().regex(/^R[1-9][0-9]*$/) }),
]);
export const memoryInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("current") }),
  z.object({ action: z.literal("new"), title: z.string().trim().min(1), objective: z.string().optional(), phase: z.string().optional(), activate: z.boolean().default(true) }),
  z.object({ action: z.literal("activate"), id: z.string().min(1) }),
  z.object({ action: z.literal("pause"), id: z.string().optional() }),
  z.object({ action: z.literal("complete"), id: z.string().optional(), summary: z.string().max(20_000).optional(), limitations: z.array(z.string().max(4_000)).max(50).default([]) }),
  z.object({ action: z.literal("update"), id: z.string().optional(), title: z.string().min(1).optional(), objective: z.string().optional(), phase: z.string().min(1).optional(), spec: z.string().max(200_000).optional() }),
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("read"), id: z.string().min(1) }),
  z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(2_000), limit: z.number().int().min(1).max(20).default(10) }),
  z.object({ action: z.literal("note"), type: taskNoteTypeSchema.exclude(["hypothesis_rejected"]), text: z.string().trim().min(1).max(20_000),
    confidence: confidenceSchema.default("medium"), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]),
    repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional() }),
  z.object({ action: z.literal("resolve"), record_id: z.string().min(1), status: memoryRecordStatusSchema,
    reason: z.string().trim().min(1).max(2_000), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]) }),
  z.object({ action: z.literal("spec_replace"), id: z.string().optional(), summary: z.string().trim().min(1).max(50_000),
    requirements: z.array(requirementInput).min(1).max(500), reason: z.string().trim().min(1).max(2_000).optional() }),
  z.object({ action: z.literal("spec_patch"), id: z.string().optional(), reason: z.string().trim().min(1).max(2_000), operations: z.array(specPatchOperation).min(1).max(100) }),
  z.object({ action: z.literal("spec_rollback"), id: z.string().optional(), revision: z.number().int().min(1), reason: z.string().trim().min(1).max(2_000) }),
]);

export const planInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), steps: z.array(planStepInputSchema).min(1).max(50),
    exceptions: z.array(z.object({ requirement_id: z.string().regex(/^R[1-9][0-9]*$/), reason: z.string().trim().min(1).max(2_000) })).max(100).default([]) }),
  z.object({ action: z.literal("current") }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("revise"), reason: z.string().trim().min(1).max(2_000), operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("replace_current"), step: planStepInputSchema }),
    z.object({ op: z.literal("append_steps"), steps: z.array(planStepInputSchema).min(1).max(49) }),
    z.object({ op: z.literal("drop_future") }),
    z.object({ op: z.literal("mark_write_not_needed"), repo: z.string().min(1), path: z.string().min(1), reason: z.string().trim().min(1).max(2_000) }),
    z.object({ op: z.literal("set_requirement_exception"), requirement_id: z.string().regex(/^R[1-9][0-9]*$/), reason: z.string().trim().min(1).max(2_000) }),
    z.object({ op: z.literal("allow_marker"), repo: z.string().min(1), path: z.string().min(1), marker: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(2_000) }),
  ])).min(1).max(50) }),
  z.object({ action: z.literal("suspend"), reason: z.string().trim().min(1).max(2_000).optional() }),
  z.object({ action: z.literal("reactivate") }),
  z.object({ action: z.literal("abandon"), reason: z.string().trim().min(1).max(2_000) }),
]);

export type ContextFindInput = z.input<typeof contextFindInput>;
export type ContextInspectInput = z.input<typeof contextInspectInput>;
export type MemoryInput = z.input<typeof memoryInput>;
export type PlanInput = z.input<typeof planInput>;
