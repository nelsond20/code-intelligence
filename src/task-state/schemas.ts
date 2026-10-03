import { z } from "zod";

export const taskStatusSchema = z.enum(["active", "paused", "completed"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const taskNoteTypeSchema = z.enum([
  "observation", "evidence", "hypothesis", "hypothesis_rejected", "decision", "question", "blocker",
]);

const hypothesisSchema = z.object({
  id: z.string(),
  text: z.string(),
  confidence: confidenceSchema,
});

export const taskStateSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  phase: z.string(),
  objective: z.string(),
  confirmed_findings: z.array(z.string()),
  active_hypotheses: z.array(hypothesisSchema),
  rejected_hypotheses: z.array(hypothesisSchema.extend({ reason: z.string().optional() })),
  open_questions: z.array(z.string()),
  blockers: z.array(z.string()).default([]),
  relevant_files: z.array(z.object({ repo: z.string(), path: z.string() })),
  relevant_symbols: z.array(z.string()),
  inspected_refs: z.array(z.string()).default([]),
  inspected_commits: z.array(z.object({ repo: z.string(), commit: z.string() })).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const taskNoteSchema = z.object({
  type: taskNoteTypeSchema,
  text: z.string().trim().min(1).max(20_000),
  confidence: confidenceSchema.optional().default("medium"),
  repo: z.string().optional(),
  file: z.string().optional(),
  symbol: z.string().optional(),
});

export const taskUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  objective: z.string().optional(),
  spec: z.string().max(200_000).optional(),
});

export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskNote = z.input<typeof taskNoteSchema>;
export type TaskUpdate = z.input<typeof taskUpdateSchema>;
