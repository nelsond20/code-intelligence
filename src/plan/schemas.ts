import { z } from "zod";

export const planWriteSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1).max(4_000),
});

export const planContextSchema = z.object({
  repo: z.string().min(1),
  file: z.string().min(1).max(4_000),
  symbol: z.string().min(1).max(1_000).optional(),
  hint: z.string().min(1).max(2_000).optional(),
});

export const planVerificationSchema = z.object({
  command: z.string().trim().min(1).max(4_000),
  expect_exit: z.number().int().min(0).max(255).default(0),
});

export const planStepInputSchema = z.object({
  id: z.string().regex(/^S[1-9][0-9]*$/, "step id must look like S1"),
  title: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(4_000),
  writes: z.array(planWriteSchema).min(1).max(20),
  multi_file_justification: z.string().trim().min(1).max(2_000).optional(),
  context: z.array(planContextSchema).max(30).default([]),
  acceptance: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  verification: z.array(planVerificationSchema).min(1).max(20),
}).superRefine((step, context) => {
  if (step.writes.length >= 3 && !step.multi_file_justification) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["multi_file_justification"], message: "3 or more writable files require a bounded justification" });
  }
});

const verificationStateSchema = planVerificationSchema.extend({
  verified_generation: z.number().int().min(0).optional(),
  last_exit: z.number().int().optional(),
});

export const planStepSchema = z.object({
  id: z.string(), title: z.string(), objective: z.string(), writes: z.array(planWriteSchema),
  multi_file_justification: z.string().optional(), context: z.array(planContextSchema), acceptance: z.array(z.string()),
  verification: z.array(verificationStateSchema), status: z.enum(["pending", "current", "completed"]),
  mutation_generation: z.number().int().min(0),
});

export const planStateSchema = z.object({
  schema_version: z.literal(1), memory_id: z.string(), spec_hash: z.string().length(64),
  revision: z.number().int().min(1), status: z.enum(["active", "completed"]), current_step: z.number().int().min(0),
  steps: z.array(planStepSchema).min(1),
  revisions: z.array(z.object({ revision: z.number().int(), reason: z.string(), at: z.string() })).max(20).default([]),
  created_at: z.string(), updated_at: z.string(),
});

export type PlanStepInput = z.input<typeof planStepInputSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanState = z.infer<typeof planStateSchema>;

