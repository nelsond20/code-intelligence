import { z } from "zod";
import { confidenceSchema, desiredRequirementInput, memoryRecordStatusSchema, taskNoteTypeSchema } from "../task-state/schemas.js";

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
  action: z.enum(["current", "note", "resolve", "spec_set"]).describe("READ: current reads the active memory, spec, and records (including continuation). WRITE: note saves a durable finding; resolve updates a memory record; spec_set replaces the complete desired spec and never reads records. Every action uses the operator-selected active memory."),
  type: taskNoteTypeSchema.exclude(["hypothesis_rejected"]).optional(),
  text: z.string().trim().min(1).max(20_000).optional(),
  confidence: confidenceSchema.optional(),
  evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).optional().describe("For note/resolve only: context refs returned by context.find and inspected with context.inspect in this memory. M* memory record IDs are not evidence refs."),
  repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional(),
  record_id: z.string().min(1).optional().describe("For resolve only: server-issued M* memory record ID; never use it in evidence_refs."), status: memoryRecordStatusSchema.optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
  summary: z.string().trim().min(1).max(50_000).optional().describe("Required for spec_set WRITE: summary of the complete desired specification; never use spec_set to read."),
  requirements: z.array(requirementInput).min(1).max(500).optional().describe("Required for spec_set WRITE: complete desired list. Each item requires statement, kind, and priority; omit id for a new item. Never use spec_set to retrieve requirements."),
  section: z.enum(["records", "requirements", "summary", "metadata", "item"]).optional().describe("ONLY for current READ continuation; selects records, requirements, summary, metadata, or one item. Never use with spec_set."),
  offset: z.number().int().min(0).optional().describe("ONLY for current READ continuation; page offset. Never use with spec_set."),
  state_token: z.string().length(64).optional().describe("ONLY for current READ continuation; obtain from memory.current. Never use with spec_set."),
  item_id: z.string().optional().describe("ONLY for current READ continuation with section=item; M* record or R* requirement ID."),
}).strict();

const memoryActions = {
  current: z.object({ action: z.literal("current"), section: z.enum(["records", "requirements", "summary", "metadata", "item"]).optional(),
    offset: z.number().int().min(0).optional(), state_token: z.string().length(64).optional(), item_id: z.string().optional() }).strict(),
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
export const compactPlanStep = z.object({
  title: z.string().trim().min(1).max(500), objective: z.string().trim().min(1).max(4_000),
  writes: z.array(z.string().min(1).max(4_000)).max(20).optional(),
  repo: z.string().min(1).optional().describe("Optional registered repository ID for unqualified write paths. Repo-prefixed and absolute write paths resolve from registered repositories."),
}).strict();
export const planInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("current"), section: z.enum(["writes", "context", "acceptance", "verification", "item"]).optional(),
    offset: z.number().int().min(0).optional(), state_token: z.string().length(64).optional(), item_id: z.string().optional() }).strict(),
  z.object({ action: z.literal("create"), steps: z.array(compactPlanStep).min(1).max(50) }).strict(),
  z.object({ action: z.literal("complete_current") }).strict(),
  z.object({ action: z.literal("revise_current"), reason: z.string().trim().min(1).max(2_000), step: compactPlanStep }).strict(),
]);

export type ContextFindInput = z.input<typeof contextFindInput>;
export type ContextInspectInput = z.input<typeof contextInspectInput>;
export type MemoryInput = z.input<typeof memoryInput>;
export type CompactPlanStep = z.input<typeof compactPlanStep>;
// Direct in-process callers may still use the historical step shape. MCP validates planInput.
type LegacyStep = { kind?: "implementation" | "investigation" | "verification"; title: string; objective: string; covers?: string[];
  writes?: Array<{ repo: string; path: string }>; acceptance?: string[];
  verification?: Array<{ kind: "test" | "typecheck" | "lint" | "build" | "custom"; program: string; args: string[]; repo?: string }> };
export type PlanInput = z.input<typeof planInput> | { action: "create"; steps: LegacyStep[] }
  | { action: "revise_current"; reason: string; step: LegacyStep };
