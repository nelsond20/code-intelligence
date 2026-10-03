import crypto from "node:crypto";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { isGloballyIgnored } from "../privacy/ignores.js";
import { TaskService } from "../task-state/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { planStepInputSchema, type PlanState, type PlanStep, type PlanStepInput } from "./schemas.js";
import { PlanStorage } from "./storage.js";

function hashSpec(spec: string): string { return crypto.createHash("sha256").update(spec.trim()).digest("hex"); }
function hasConfirmedSpec(spec: string): boolean {
  return spec.split(/\r?\n/).some((line) => {
    const value = line.trim();
    return value && !value.startsWith("#") && value !== "Confirmed design and implementation conclusions are recorded here.";
  });
}

export class PlanService {
  constructor(readonly storage = new PlanStorage(), readonly tasks = new TaskService(storage.tasks), readonly registry = new WorkspaceRegistry()) {}

  private async active(workspaceId: string) {
    const memory = await this.tasks.current(workspaceId);
    if (!memory) throw new Error("An active memory work item is required");
    return memory;
  }

  private async spec(workspaceId: string, memoryId: string): Promise<string> {
    const spec = await this.storage.tasks.readSpec(workspaceId, memoryId);
    if (!hasConfirmedSpec(spec)) throw new Error("A non-empty confirmed spec is required before creating or revising a plan");
    return spec;
  }

  private async canonicalPath(workspaceId: string, repo: string, requested: string): Promise<string> {
    if (path.isAbsolute(requested)) throw new Error(`Absolute writable paths are not allowed: ${requested}`);
    const normalized = path.posix.normalize(requested.replaceAll("\\", "/"));
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`Path escapes the repository: ${requested}`);
    if (isGloballyIgnored(normalized)) throw new Error(`Ignored or secret paths cannot be authorized: ${requested}`);
    const repository = await this.registry.resolveRepository(workspaceId, repo);
    const root = await realpath(repository.path); const candidate = path.resolve(root, normalized);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes the repository: ${requested}`);
    try {
      const canonical = await realpath(candidate); const canonicalRelative = path.relative(root, canonical);
      if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) throw new Error(`Symlink escapes the repository: ${requested}`);
      if (!(await stat(canonical)).isFile()) throw new Error(`Writable path is not a regular file: ${requested}`);
      return canonicalRelative.replaceAll(path.sep, "/");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await realpath(path.dirname(candidate));
      const parentRelative = path.relative(root, parent);
      if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error(`Symlink escapes the repository: ${requested}`);
      return relative.replaceAll(path.sep, "/");
    }
  }

  private async normalizeStep(workspaceId: string, input: PlanStepInput, status: PlanStep["status"]): Promise<PlanStep> {
    const parsed = planStepInputSchema.parse(input);
    const writes = await Promise.all(parsed.writes.map(async (item) => ({ repo: item.repo, path: await this.canonicalPath(workspaceId, item.repo, item.path) })));
    const unique = new Set(writes.map((item) => `${item.repo}:${item.path}`));
    if (unique.size !== writes.length) throw new Error(`Step ${parsed.id} contains duplicate writable paths`);
    const context = await Promise.all(parsed.context.map(async (item) => ({ ...item, file: await this.canonicalPath(workspaceId, item.repo, item.file) })));
    return { ...parsed, writes, context, status, mutation_generation: 0, verification: parsed.verification.map((item) => ({ ...item })) };
  }

  private assertUniqueSteps(steps: Array<{ id: string }>): void {
    if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error("Plan step ids must be unique");
  }

  async create(workspaceId: string, inputs: PlanStepInput[]): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId); const spec = await this.spec(workspaceId, memory.id);
      if (!inputs.length || inputs.length > 50) throw new Error("A plan requires 1 to 50 steps");
      this.assertUniqueSteps(inputs);
      const steps = await Promise.all(inputs.map((step, index) => this.normalizeStep(workspaceId, step, index === 0 ? "current" : "pending")));
      const now = new Date().toISOString();
      const plan: PlanState = { schema_version: 1, memory_id: memory.id, spec_hash: hashSpec(spec), revision: 1,
        status: "active", current_step: 0, steps, revisions: [], created_at: now, updated_at: now };
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async state(workspaceId: string): Promise<{ plan?: PlanState; stale: boolean }> {
    const memory = await this.tasks.current(workspaceId); if (!memory) return { stale: false };
    const plan = await this.storage.read(workspaceId, memory.id); if (!plan) return { stale: false };
    const spec = await this.storage.tasks.readSpec(workspaceId, memory.id);
    return { plan, stale: hashSpec(spec) !== plan.spec_hash };
  }

  async current(workspaceId: string) {
    const { plan, stale } = await this.state(workspaceId); if (!plan) return { active: false as const };
    if (plan.status === "completed") return { active: false as const, completed: true as const, revision: plan.revision };
    const step = plan.steps[plan.current_step]!;
    return { active: true as const, stale, revision: plan.revision, position: plan.current_step + 1, total: plan.steps.length,
      step: { id: step.id, title: step.title, objective: step.objective, writes: step.writes, context: step.context,
        acceptance: step.acceptance, verification: step.verification.map(({ command, expect_exit, verified_generation }) => ({ command, expect_exit, current: verified_generation === step.mutation_generation })),
        mutation_generation: step.mutation_generation } };
  }

  async context(workspaceId: string): Promise<string> {
    const current = await this.current(workspaceId);
    if (!current.active) return "## ACTIVE PLAN\n\nNone.";
    return ["## ACTIVE PLAN", `Status: ${current.stale ? "STALE" : "active"}; revision ${current.revision}`,
      `Current: ${current.position}/${current.total} — ${current.step.id} ${current.step.title}`,
      `Goal: ${current.step.objective}`, `Write: ${current.step.writes.map((item) => `${item.repo}:${item.path}`).join(", ")}`].join("\n\n");
  }

  async complete(workspaceId: string) {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active") throw new Error("No active plan");
      if (stale) return { advanced: false, message: "STEP NOT COMPLETE", missing: ["plan is stale because the confirmed spec changed"] };
      const step = plan.steps[plan.current_step]!; const missing: string[] = [];
      if (step.status !== "current") missing.push("current step is not active");
      for (const verification of step.verification) {
        if (verification.verified_generation !== step.mutation_generation || verification.last_exit !== verification.expect_exit) {
          missing.push(`${verification.command} has not passed for mutation generation ${step.mutation_generation}`);
        }
      }
      if (missing.length) return { advanced: false, message: "STEP NOT COMPLETE", missing };
      step.status = "completed"; const completed = plan.current_step;
      if (completed + 1 < plan.steps.length) { plan.current_step += 1; plan.steps[plan.current_step]!.status = "current"; }
      else plan.status = "completed";
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
      return { advanced: true, completed_step: step.id, plan_completed: plan.status === "completed",
        current_step: plan.status === "active" ? plan.steps[plan.current_step]!.id : undefined };
    });
  }

  async revise(workspaceId: string, reason: string, currentInput: PlanStepInput, futureInputs: PlanStepInput[] = []): Promise<PlanState> {
    if (!reason.trim() || reason.trim().length > 2_000) throw new Error("Plan revision requires a bounded reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId); const spec = await this.spec(workspaceId, memory.id);
      const existing = await this.storage.read(workspaceId, memory.id); if (!existing || existing.status !== "active") throw new Error("No active plan");
      const current = existing.steps[existing.current_step]!;
      if (currentInput.id !== current.id) throw new Error(`Revision cannot skip the server-owned current step ${current.id}`);
      this.assertUniqueSteps([currentInput, ...futureInputs]);
      const revisedCurrent = await this.normalizeStep(workspaceId, currentInput, "current");
      const future = await Promise.all(futureInputs.map((step) => this.normalizeStep(workspaceId, step, "pending")));
      existing.steps = [...existing.steps.slice(0, existing.current_step), revisedCurrent, ...future];
      existing.spec_hash = hashSpec(spec); existing.revision += 1; existing.updated_at = new Date().toISOString();
      existing.revisions = [...existing.revisions, { revision: existing.revision, reason: reason.trim(), at: existing.updated_at }].slice(-20);
      await this.storage.write(workspaceId, existing); return existing;
    });
  }

  async recordMutation(workspaceId: string): Promise<void> {
    await this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) throw new Error("No valid active plan");
      const step = plan.steps[plan.current_step]!; step.mutation_generation += 1;
      step.verification = step.verification.map(({ verified_generation: _generation, last_exit: _exit, ...verification }) => verification);
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
    });
  }

  async recordVerification(workspaceId: string, command: string, exitCode: number): Promise<boolean> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) return false;
      const step = plan.steps[plan.current_step]!; const verification = step.verification.find((item) => item.command === command);
      if (!verification) return false;
      verification.last_exit = exitCode;
      if (exitCode === verification.expect_exit) verification.verified_generation = step.mutation_generation;
      else delete verification.verified_generation;
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan); return true;
    });
  }
}
