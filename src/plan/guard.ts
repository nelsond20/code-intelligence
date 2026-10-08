import path from "node:path";
import { realpath } from "node:fs/promises";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { PlanService, verificationCommand } from "./service.js";
import { canonicalTarget } from "./target-path.js";

export interface GuardDecision { allowed: boolean; kind: "mutation" | "verification" | "other"; reason?: string; }

export class PlanGuard {
  constructor(readonly plans = new PlanService(), readonly registry = plans.registry) {}

  private async identify(workspaceId: string, target: string): Promise<{ repo: string; path: string }> {
    const workspace = await this.registry.get(workspaceId);
    const absolute = path.resolve(target);
    for (const repository of workspace.repositories) {
      const root = await realpath(repository.path);
      const relative = path.relative(root, absolute);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return { repo: repository.id, path: await canonicalTarget(root, relative, true) };
      }
    }
    throw new Error(`Mutation target is outside registered repositories: ${target}`);
  }

  async beforeMutation(workspaceId: string, targets: string[]): Promise<GuardDecision> {
    const { plan, stale } = await this.plans.state(workspaceId);
    if (!plan || ["completed", "abandoned"].includes(plan.status)) {
      const memory = await this.plans.tasks.current(workspaceId);
      if (memory && !memory.spec_archived_at && await this.plans.storage.tasks.readStructuredSpec(workspaceId, memory.id))
        return { allowed: false, kind: "mutation", reason: "PLAN_REQUIRED: Create the persistent Code Intelligence plan before modifying workspace files." };
      return { allowed: true, kind: "mutation" };
    }
    if (plan.status === "suspended") return { allowed: false, kind: "mutation", reason: "The current memory has a suspended plan; reactivate or abandon it before mutating files" };
    if (plan.status === "final_review") return { allowed: false, kind: "mutation", reason: "The plan is in final review; use operator controls to resolve findings before further writes" };
    if (plan.status !== "active") return { allowed: true, kind: "mutation" };
    if (stale) return { allowed: false, kind: "mutation", reason: "PLAN_STALE: Active plan is stale because the structured spec changed" };
    if (plan.steps[plan.current_step]?.status !== "current") return { allowed: false, kind: "mutation", reason: "No valid current plan step authorizes workspace mutation" };
    if (!targets.length) return { allowed: false, kind: "mutation", reason: "Mutation target could not be determined" };
    const allowed = new Set(plan.steps[plan.current_step]!.writes.map((item) => `${item.repo}:${item.path}`));
    try {
      const identified = await Promise.all(targets.map((target) => this.identify(workspaceId, target)));
      const denied = identified.find((item) => !allowed.has(`${item.repo}:${item.path}`));
      if (denied) return { allowed: false, kind: "mutation", reason: `Current step does not authorize ${denied.repo}:${denied.path}` };
      const pending = plan.steps[plan.current_step]!;
      if (pending.pending_shell) return { allowed: false, kind: "mutation", reason: "Previous tool effects have not been verified" };
      if (pending.pending_mutation) {
        const prior = new Set(pending.pending_mutation.targets.map((item) => `${item.repo}:${item.path}`));
        if (identified.every((item) => prior.has(`${item.repo}:${item.path}`))) return { allowed: true, kind: "mutation" };
        return { allowed: false, kind: "mutation", reason: "Previous tool effects have not been verified" };
      }
      await this.plans.captureMutation(workspaceId, identified);
      return { allowed: true, kind: "mutation" };
    } catch (error) { return { allowed: false, kind: "mutation", reason: (error as Error).message }; }
  }

  async beforeShell(workspaceId: string, command: string): Promise<GuardDecision> {
    const mutation = /(^|[;&|]\s*)(rm|mv|cp|install|touch|truncate|tee|sed\s+-[^\n]*i|perl\s+-[^\n]*i|python(?:3)?\b[^\n]*(?:write|unlink|rename)|node\b[^\n]*(?:writeFile|unlink|rename))\b|(^|[^>])>{1,2}(?!>)|\b(?:writeFile|appendFile|writeTextFile|unlink|rename|rmSync|Bun\.write)\s*\(/i;
    const { plan, stale } = await this.plans.state(workspaceId);
    if (!plan || ["completed", "abandoned"].includes(plan.status)) {
      const memory = await this.plans.tasks.current(workspaceId);
      // Shell commands can mutate through scripts, child processes, and tools whose
      // names do not reveal their effects. There is no read-only shell sandbox here.
      if (memory && !memory.spec_archived_at && await this.plans.storage.tasks.readStructuredSpec(workspaceId, memory.id))
        return { allowed: false, kind: "mutation", reason: "PLAN_REQUIRED: Create the persistent Code Intelligence plan before running workspace shell commands." };
      return { allowed: true, kind: "other" };
    }
    if (plan.status === "suspended") return { allowed: false, kind: "other", reason: "The current memory has a suspended plan; reactivate or abandon it before executing commands" };
    if (plan.status === "final_review") return mutation.test(command)
      ? { allowed: false, kind: "mutation", reason: "The plan is in final review; writes require operator resolution" }
      : { allowed: true, kind: "other" };
    if (plan.status !== "active") return { allowed: true, kind: "other" };
    const step = plan.steps[plan.current_step];
    if (!step || step.status !== "current") return { allowed: false, kind: "other", reason: "No valid current plan step authorizes workspace commands" };
    if (mutation.test(command)) return { allowed: false, kind: "mutation", reason: stale
      ? "Active plan is stale because the confirmed spec changed"
      : "Detectable shell-based file mutation is blocked while a guarded plan is active" };
    if (step.pending_shell || step.pending_mutation) return { allowed: false, kind: "other", reason: "Previous tool effects have not been verified" };
    if (stale) return { allowed: false, kind: "other", reason: "Active plan is stale because the confirmed spec changed" };
    await this.plans.captureShell(workspaceId);
    if (step.verification.some((item) => verificationCommand(item) === command.trim())) return { allowed: true, kind: "verification" };
    return { allowed: true, kind: "other" };
  }

  async afterMutation(workspaceId: string, targets: string[] = []): Promise<boolean> {
    const identified = targets.length ? await Promise.all(targets.map((target) => this.identify(workspaceId, target))) : [];
    return this.plans.recordMutation(workspaceId, identified);
  }
  async afterVerification(workspaceId: string, command: string, exitCode: number): Promise<boolean> {
    return this.plans.recordVerification(workspaceId, command.trim(), exitCode);
  }
  async afterShell(workspaceId: string, command: string, exitCode: number) { return this.plans.recordShell(workspaceId, command.trim(), exitCode); }
}
