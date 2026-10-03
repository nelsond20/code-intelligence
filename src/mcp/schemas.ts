import { z } from "zod";
import { confidenceSchema, taskNoteTypeSchema } from "../task-state/schemas.js";
import { planStepInputSchema } from "../plan/schemas.js";

export const contextFindInput = z.object({
  query: z.string().min(1).max(2_000), scope: z.string().default("auto"),
  sources: z.array(z.enum(["code", "docs", "vault", "git"])).max(4).optional(), limit: z.number().int().min(1).max(20).default(8),
});
export const contextInspectInput = z.object({
  ref: z.string().min(1).max(4_000), view: z.enum(["content", "surrounding", "relations", "references", "summary", "diff", "file", "impact", "blame"]).default("content"),
});
export const memoryInput = z.object({
  action: z.enum(["current", "new", "activate", "pause", "complete", "update", "list", "note"]),
  id: z.string().optional(), title: z.string().optional(), objective: z.string().optional(), phase: z.string().optional(),
  spec: z.string().optional(), activate: z.boolean().optional(),
  type: taskNoteTypeSchema.optional(), text: z.string().min(1).optional(), confidence: confidenceSchema.optional(),
  repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional() });

export const planInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), steps: z.array(planStepInputSchema).min(1).max(50) }),
  z.object({ action: z.literal("current") }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("revise"), reason: z.string().trim().min(1).max(2_000), current_step: planStepInputSchema,
    future_steps: z.array(planStepInputSchema).max(49).default([]) }),
]);

export type ContextFindInput = z.input<typeof contextFindInput>;
export type ContextInspectInput = z.input<typeof contextInspectInput>;
export type MemoryInput = z.input<typeof memoryInput>;
export type PlanInput = z.input<typeof planInput>;
