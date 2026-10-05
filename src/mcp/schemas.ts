import { z } from "zod";
import { confidenceSchema, memoryRecordStatusSchema, taskNoteTypeSchema } from "../task-state/schemas.js";
import { planStepInputSchema } from "../plan/schemas.js";

export const contextFindInput = z.object({
  query: z.string().min(1).max(2_000), scope: z.string().default("auto"),
  sources: z.array(z.enum(["code", "docs", "vault", "git"])).max(4).optional(), limit: z.number().int().min(1).max(20).default(8),
}).strict();
export const contextInspectInput = z.object({
  ref: z.string().min(1).max(4_000), view: z.enum(["content", "surrounding", "relations", "references", "summary", "diff", "file", "impact", "blame"]).default("content"),
}).strict();
const requirementInput = z.object({ statement: z.string().trim().min(1).max(10_000).describe("Observable requirement statement; do not use description"),
  kind: z.enum(["behavior", "constraint"]).describe("Requirement kind; choose constraint for a constraint requirement"),
  priority: z.enum(["must", "should"]).describe("Requirement priority; choose must for a MUST requirement. This is not a memory action") }).strict();
const specPatchOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), requirement: requirementInput }).strict(),
  z.object({ op: z.literal("update"), id: z.string().regex(/^R[1-9][0-9]*$/), requirement: requirementInput.partial() }).strict(),
  z.object({ op: z.literal("remove"), id: z.string().regex(/^R[1-9][0-9]*$/) }).strict(),
]);
export const memoryInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("current") }).strict(),
  z.object({ action: z.literal("new"), title: z.string().trim().min(1).describe("Required for new memory; do not add state or context fields"), objective: z.string().optional(), phase: z.string().optional(), activate: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("spec_replace").describe("Create the first structured spec or replace the whole existing spec. For one constraint MUST requirement, use action spec_replace with requirements: [{statement, kind: 'constraint', priority: 'must'}]. There is no spec_must action"), id: z.string().optional().describe("Existing memory ID returned by new; omit for the active memory and never invent an ID"), summary: z.string().trim().min(1).max(50_000).describe("Top-level spec summary; do not nest in spec"),
    requirements: z.array(requirementInput).min(1).max(500).describe("Top-level requirements; server assigns R1, R2, ..."), reason: z.string().trim().min(1).max(2_000).optional().describe("Required when replacing an existing spec") }).strict(),
  z.object({ action: z.literal("activate"), id: z.string().min(1) }).strict(),
  z.object({ action: z.literal("pause"), id: z.string().optional() }).strict(),
  z.object({ action: z.literal("complete"), id: z.string().optional(), summary: z.string().max(20_000).optional(), limitations: z.array(z.string().max(4_000)).max(50).default([]) }).strict(),
  z.object({ action: z.literal("update"), id: z.string().optional(), title: z.string().min(1).optional(), objective: z.string().optional(), phase: z.string().min(1).optional(), spec: z.string().max(200_000).optional() }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read"), id: z.string().min(1) }).strict(),
  z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(2_000), limit: z.number().int().min(1).max(20).default(10) }).strict(),
  z.object({ action: z.literal("note"), type: taskNoteTypeSchema.exclude(["hypothesis_rejected"]).describe("Record kind: observation, evidence, hypothesis, decision, question, or blocker"), text: z.string().trim().min(1).max(20_000).describe("Record text; use text, not body"),
    confidence: confidenceSchema.default("medium"), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]).describe("Refs already inspected in this memory; nonempty refs make the record supported"),
    repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional() }).strict(),
  z.object({ action: z.literal("resolve"), record_id: z.string().min(1).describe("M* ID returned by memory.note"), status: memoryRecordStatusSchema,
    reason: z.string().trim().min(1).max(2_000), evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]).describe("Confirmation requires an inspected ref, either already on the record or supplied here") }).strict(),
  z.object({ action: z.literal("spec_patch"), id: z.string().optional(), reason: z.string().trim().min(1).max(2_000), operations: z.array(specPatchOperation).min(1).max(100) }).strict(),
  z.object({ action: z.literal("spec_rollback"), id: z.string().optional(), revision: z.number().int().min(1), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

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
