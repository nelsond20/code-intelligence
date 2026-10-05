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
    const { plan, stale } = await this.plans.state(workspaceId); if (!plan) return { allowed: true, kind: "mutation" };
    if (plan.status === "suspended") return { allowed: false, kind: "mutation", reason: "The current memory has a suspended plan; reactivate or abandon it before mutating files" };
    if (plan.status !== "active") return { allowed: true, kind: "mutation" };
    if (stale) return { allowed: false, kind: "mutation", reason: "Active plan is stale because the confirmed spec changed" };
    if (!targets.length) return { allowed: false, kind: "mutation", reason: "Mutation target could not be determined" };
    const allowed = new Set(plan.steps[plan.current_step]!.writes.map((item) => `${item.repo}:${item.path}`));
    try {
      const identified = await Promise.all(targets.map((target) => this.identify(workspaceId, target)));
      const denied = identified.find((item) => !allowed.has(`${item.repo}:${item.path}`));
      if (denied) return { allowed: false, kind: "mutation", reason: `Current step does not authorize ${denied.repo}:${denied.path}` };
      await this.plans.captureMutation(workspaceId, identified);
      return { allowed: true, kind: "mutation" };
    } catch (error) { return { allowed: false, kind: "mutation", reason: (error as Error).message }; }
  }

  async beforeShell(workspaceId: string, command: string): Promise<GuardDecision> {
    const { plan, stale } = await this.plans.state(workspaceId); if (!plan) return { allowed: true, kind: "other" };
    if (plan.status === "suspended") return { allowed: false, kind: "other", reason: "The current memory has a suspended plan; reactivate or abandon it before executing commands" };
    if (plan.status !== "active") return { allowed: true, kind: "other" };
    const step = plan.steps[plan.current_step]!;
    const mutation = /(^|[;&|]\s*)(rm|mv|cp|install|touch|truncate|tee|sed\s+-[^\n]*i|perl\s+-[^\n]*i|python(?:3)?\b[^\n]*(?:write|unlink|rename)|node\b[^\n]*(?:writeFile|unlink|rename))\b|(^|[^>])>{1,2}(?!>)|\b(?:writeFile|appendFile|writeTextFile|unlink|rename|rmSync|Bun\.write)\s*\(/i;
    if (mutation.test(command)) return { allowed: false, kind: "mutation", reason: stale
      ? "Active plan is stale because the confirmed spec changed"
      : "Detectable shell-based file mutation is blocked while a guarded plan is active" };
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
