import { z } from "zod";

export const taskStatusSchema = z.enum(["active", "paused", "completed"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const taskNoteTypeSchema = z.enum([
  "observation", "evidence", "hypothesis", "hypothesis_rejected", "decision", "question", "blocker",
]);
export const memoryRecordStatusSchema = z.enum(["observed", "supported", "confirmed", "superseded", "rejected", "resolved", "ruled_out"]);
export const requirementSchema = z.object({
  id: z.string().regex(/^R[1-9][0-9]*$/), statement: z.string().trim().min(1).max(10_000),
  kind: z.enum(["behavior", "constraint"]), priority: z.enum(["must", "should"]),
});
export const structuredSpecSchema = z.object({
  revision: z.number().int().min(1), summary: z.string().trim().min(1).max(50_000), requirements: z.array(requirementSchema).min(1).max(500),
  reason: z.string().max(2_000).optional(), created_at: z.string(),
});
const memoryRecordSchema = z.object({
  id: z.string(), kind: z.enum(["observation", "evidence", "hypothesis", "decision", "question", "blocker"]),
  text: z.string(), status: memoryRecordStatusSchema, confidence: confidenceSchema,
  evidence_refs: z.array(z.string()).default([]), repo: z.string().optional(), file: z.string().optional(), symbol: z.string().optional(),
  reason: z.string().optional(), created_at: z.string(), updated_at: z.string(),
});

const hypothesisSchema = z.object({
  id: z.string(),
  text: z.string(),
  confidence: confidenceSchema,
});

export const taskStateSchema = z.object({
  schema_version: z.literal(2),
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
  inspected_files: z.array(z.object({ repo: z.string(), path: z.string() })).default([]),
  inspected_symbols: z.array(z.string()).default([]),
  inspected_commits: z.array(z.object({ repo: z.string(), commit: z.string() })).default([]),
  records: z.array(memoryRecordSchema).max(500).default([]),
  outcome: z.object({ summary: z.string(), limitations: z.array(z.string()), evidence_refs: z.array(z.string()), completed_at: z.string() }).optional(),
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
  evidence_refs: z.array(z.string().min(1).max(4_000)).max(50).default([]),
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
export type StructuredSpec = z.infer<typeof structuredSpecSchema>;
export type MemoryRecordStatus = z.infer<typeof memoryRecordStatusSchema>;
