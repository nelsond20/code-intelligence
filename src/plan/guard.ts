import path from "node:path";
import { realpath } from "node:fs/promises";
import { isGloballyIgnored } from "../privacy/ignores.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { PlanService } from "./service.js";

export interface GuardDecision { allowed: boolean; kind: "mutation" | "verification" | "other"; reason?: string; }

export class PlanGuard {
  constructor(readonly plans = new PlanService(), readonly registry = plans.registry) {}

  private async identify(workspaceId: string, target: string): Promise<{ repo: string; path: string }> {
    const workspace = await this.registry.get(workspaceId);
    const absolute = path.resolve(target);
    let canonical = absolute;
    try { canonical = await realpath(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
    }
    for (const repository of workspace.repositories) {
      const root = await realpath(repository.path);
      const relative = path.relative(root, canonical);
      if (!relative.startsWith("..") && !path.isAbsolute(relative) && relative && !isGloballyIgnored(relative)) {
        return { repo: repository.id, path: relative.replaceAll(path.sep, "/") };
      }
    }
    throw new Error(`Mutation target is outside registered repositories: ${target}`);
  }

  async beforeMutation(workspaceId: string, targets: string[]): Promise<GuardDecision> {
    const { plan, stale } = await this.plans.state(workspaceId); if (!plan || plan.status !== "active") return { allowed: true, kind: "mutation" };
    if (stale) return { allowed: false, kind: "mutation", reason: "Active plan is stale because the confirmed spec changed" };
    if (!targets.length) return { allowed: false, kind: "mutation", reason: "Mutation target could not be determined" };
    const allowed = new Set(plan.steps[plan.current_step]!.writes.map((item) => `${item.repo}:${item.path}`));
    try {
      const identified = await Promise.all(targets.map((target) => this.identify(workspaceId, target)));
      const denied = identified.find((item) => !allowed.has(`${item.repo}:${item.path}`));
      return denied ? { allowed: false, kind: "mutation", reason: `Current step does not authorize ${denied.repo}:${denied.path}` } : { allowed: true, kind: "mutation" };
    } catch (error) { return { allowed: false, kind: "mutation", reason: (error as Error).message }; }
  }

  async beforeShell(workspaceId: string, command: string): Promise<GuardDecision> {
    const { plan, stale } = await this.plans.state(workspaceId); if (!plan || plan.status !== "active") return { allowed: true, kind: "other" };
    const step = plan.steps[plan.current_step]!;
    if (step.verification.some((item) => item.command === command.trim())) return stale
      ? { allowed: false, kind: "verification", reason: "Active plan is stale because the confirmed spec changed" }
      : { allowed: true, kind: "verification" };
    const mutation = /(^|[;&|]\s*)(rm|mv|cp|install|touch|truncate|tee|sed\s+-[^\n]*i|perl\s+-[^\n]*i|python(?:3)?\b[^\n]*(?:write|unlink|rename)|node\b[^\n]*(?:writeFile|unlink|rename))\b|(^|[^>])>{1,2}(?!>)|\b(?:writeFile|appendFile|writeTextFile|unlink|rename|rmSync|Bun\.write)\s*\(/i;
    if (mutation.test(command)) return { allowed: false, kind: "mutation", reason: stale
      ? "Active plan is stale because the confirmed spec changed"
      : "Detectable shell-based file mutation is blocked while a guarded plan is active" };
    return { allowed: true, kind: "other" };
  }

  async afterMutation(workspaceId: string): Promise<void> { await this.plans.recordMutation(workspaceId); }
  async afterVerification(workspaceId: string, command: string, exitCode: number): Promise<boolean> {
    return this.plans.recordVerification(workspaceId, command.trim(), exitCode);
  }
}
