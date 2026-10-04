import { z } from "zod";

export const planWriteSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1).max(4_000),
  purpose: z.string().trim().min(1).max(2_000).optional(),
  covers: z.array(z.string().regex(/^R[1-9][0-9]*$/)).max(50).default([]),
  not_needed_reason: z.string().trim().min(1).max(2_000).optional(),
});

export const planContextSchema = z.object({
  repo: z.string().min(1),
  file: z.string().min(1).max(4_000),
  symbol: z.string().min(1).max(1_000).optional(),
  hint: z.string().min(1).max(2_000).optional(),
});

const planVerificationBaseSchema = z.object({
  kind: z.enum(["test", "typecheck", "lint", "build", "custom"]).default("test"),
  command: z.string().trim().min(1).max(4_000).optional(),
  program: z.string().trim().min(1).max(200).optional(),
  args: z.array(z.string().max(2_000)).max(100).default([]),
  repo: z.string().min(1).optional(),
  cwd: z.string().max(4_000).optional(),
  expect_exit: z.number().int().min(0).max(255).default(0),
});
export const planVerificationSchema = planVerificationBaseSchema.superRefine((verification, context) => {
  if (!verification.command && !verification.program) context.addIssue({ code: z.ZodIssueCode.custom, message: "verification requires program+args (or legacy command)" });
  if (verification.command && verification.program) context.addIssue({ code: z.ZodIssueCode.custom, message: "verification cannot mix command with program+args" });
});

const acceptanceInputSchema = z.union([
  z.string().trim().min(1).max(2_000),
  z.object({ statement: z.string().trim().min(1).max(2_000), covers: z.array(z.string().regex(/^R[1-9][0-9]*$/)).max(50).default([]),
    verified_by: z.array(z.number().int().min(1).max(20)).max(20).default([]) }),
]);
const acceptanceStateSchema = z.object({
  id: z.string().regex(/^A[1-9][0-9]*$/), statement: z.string(), covers: z.array(z.string()), verification_ids: z.array(z.string()).min(1),
});

export const planStepInputSchema = z.object({
  id: z.string().regex(/^S[1-9][0-9]*$/, "step id must look like S1").optional(),
  kind: z.enum(["implementation", "investigation", "verification"]).default("implementation"),
  title: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(4_000),
  covers: z.array(z.string().regex(/^R[1-9][0-9]*$/)).max(50).default([]),
  writes: z.array(planWriteSchema).max(20).default([]),
  multi_file_justification: z.string().trim().min(1).max(2_000).optional(),
  context: z.array(planContextSchema).max(30).default([]),
  acceptance: z.array(acceptanceInputSchema).min(1).max(30),
  verification: z.array(planVerificationSchema).min(1).max(20),
}).superRefine((step, context) => {
  if (step.kind === "implementation" && step.writes.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["writes"], message: "implementation steps require at least one write" });
  if (step.kind !== "implementation" && step.writes.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["writes"], message: `${step.kind} steps cannot authorize writes` });
  if (step.writes.length >= 3 && !step.multi_file_justification) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["multi_file_justification"], message: "3 or more writable files require a bounded justification" });
  }
});

const verificationStateSchema = planVerificationBaseSchema.extend({
  id: z.string().optional(),
  verified_generation: z.number().int().min(0).optional(),
  last_exit: z.number().int().optional(),
});

export const planStepSchema = z.object({
  id: z.string(), kind: z.enum(["implementation", "investigation", "verification"]).default("implementation"),
  title: z.string(), objective: z.string(), covers: z.array(z.string()).default([]), writes: z.array(planWriteSchema),
  multi_file_justification: z.string().optional(), context: z.array(planContextSchema), acceptance: z.array(acceptanceStateSchema),
  verification: z.array(verificationStateSchema), status: z.enum(["pending", "current", "completed"]),
  mutation_generation: z.number().int().min(0),
  modified_paths: z.array(planWriteSchema.pick({ repo: true, path: true })).default([]),
  pending_mutation: z.object({ targets: z.array(z.object({ repo: z.string(), path: z.string(), hash: z.string().optional() })) }).optional(),
  pending_shell: z.object({ files: z.array(z.object({ repo: z.string(), path: z.string(), hash: z.string() })) }).optional(),
  violations: z.array(z.object({ repo: z.string(), path: z.string(), reason: z.string(), at: z.string() })).default([]),
});

export const planStateSchema = z.object({
  schema_version: z.literal(1), memory_id: z.string(), spec_hash: z.string().length(64),
  revision: z.number().int().min(1), status: z.enum(["active", "suspended", "final_review", "completed", "abandoned"]), current_step: z.number().int().min(0),
  steps: z.array(planStepSchema).min(1),
  revisions: z.array(z.object({ revision: z.number().int(), reason: z.string(), at: z.string() })).max(20).default([]),
  lifecycle: z.array(z.object({ status: z.string(), reason: z.string().optional(), at: z.string() })).max(50).default([]),
  requirement_exceptions: z.array(z.object({ requirement_id: z.string(), reason: z.string() })).max(100).default([]),
  marker_exceptions: z.array(z.object({ repo: z.string(), path: z.string(), marker: z.string(), reason: z.string() })).max(100).default([]),
  final_evidence: z.object({ covered_requirements: z.array(z.string()), modified_paths: z.array(z.string()), verifications: z.array(z.string()), completed_at: z.string() }).optional(),
  created_at: z.string(), updated_at: z.string(),
});

export type PlanStepInput = z.input<typeof planStepInputSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanState = z.infer<typeof planStateSchema>;
