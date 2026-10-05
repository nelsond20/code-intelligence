import { TaskService } from "../task-state/service.js";
import { PlanStorage } from "../plan/storage.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { TaskState } from "../task-state/schemas.js";

export type MemoryFilters = { query?: string; status?: string; phase?: string; has_spec?: string; unresolved?: string; modified?: string; sort?: string };
export type PlanDecision = "suspend" | "abandon";

export class MemoryControlService {
  constructor(readonly tasks = new TaskService(), readonly registry = new WorkspaceRegistry(), readonly planStorage = new PlanStorage(tasks.storage)) {}

  async workspaces() { return this.registry.list(); }

  async list(workspace: string, filters: MemoryFilters = {}) {
    await this.registry.get(workspace);
    const query = (filters.query || "").trim().toLocaleLowerCase();
    const rows = [];
    for (const state of await this.tasks.list(workspace)) {
      const spec = await this.tasks.storage.readStructuredSpec(workspace, state.id);
      const plan = await this.planStorage.read(workspace, state.id);
      const unresolved = state.records.some((item) => ["observed", "supported"].includes(item.status));
      const haystack = [state.title, state.objective, spec?.summary, ...(spec?.requirements.map((item) => item.statement) || []), ...state.records.map((item) => item.text)].join("\n").toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      if (filters.status && filters.status !== "all" && state.status !== filters.status) continue;
      if (filters.phase && filters.phase !== "all" && state.phase !== filters.phase) continue;
      if (filters.has_spec === "yes" && !spec || filters.has_spec === "no" && !!spec) continue;
      if (filters.unresolved === "yes" && !unresolved || filters.unresolved === "no" && unresolved) continue;
      if (filters.modified === "day" && Date.now() - Date.parse(state.updated_at) > 86_400_000) continue;
      if (filters.modified === "week" && Date.now() - Date.parse(state.updated_at) > 7 * 86_400_000) continue;
      if (filters.modified === "month" && Date.now() - Date.parse(state.updated_at) > 30 * 86_400_000) continue;
      rows.push({ id: state.id, title: state.title, status: state.status, phase: state.phase, updated_at: state.updated_at,
        has_spec: !!spec, unresolved, record_count: state.records.length, plan_status: plan?.status });
    }
    if (filters.sort === "oldest") rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    else if (filters.sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
    else rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return rows;
  }

  async detail(workspace: string, id: string) {
    await this.registry.get(workspace);
    const memory = await this.tasks.read(workspace, id);
    const plan = await this.planStorage.read(workspace, id);
    const revisions = [];
    for (let revision = 1; revision <= (memory.spec?.revision || 0); revision++) revisions.push(await this.tasks.storage.readSpecRevision(workspace, id, revision));
    return { memory, plan_status: plan?.status, revisions };
  }

  async create(workspace: string, phase = "investigation") {
    await this.registry.get(workspace);
    if (!["investigation", "implementation", "verification", "review"].includes(phase)) throw new Error("Invalid phase");
    const title = `${workspace} - ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
    return this.tasks.create(workspace, title, { phase, activate: false });
  }

  private async settlePlan(workspace: string, memory: TaskState, decision?: PlanDecision) {
    const plan = await this.planStorage.read(workspace, memory.id);
    if (!plan || !["active", "final_review"].includes(plan.status)) {
      if (plan?.status === "suspended" && decision === "abandon") {
        plan.status = "abandoned"; plan.updated_at = new Date().toISOString();
        plan.lifecycle.push({ status: "abandoned", reason: "Local operator completed memory", at: plan.updated_at });
        await this.planStorage.write(workspace, plan);
      }
      return plan;
    }
    if (!decision) throw new Error("ACTIVE_PLAN_CONFIRMATION_REQUIRED");
    if (plan.status === "final_review" && decision === "suspend") throw new Error("Final review plan must be abandoned before leaving the memory");
    plan.status = decision === "suspend" ? "suspended" : "abandoned";
    plan.updated_at = new Date().toISOString();
    plan.lifecycle.push({ status: plan.status, reason: "Local operator confirmed memory transition", at: plan.updated_at });
    await this.planStorage.write(workspace, plan);
    return plan;
  }

  async activate(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const all = await this.tasks.list(workspace); const target = all.find((item) => item.id === id);
      if (!target) throw new Error(`Unknown memory: ${id}`);
      if (target.status === "completed") throw new Error("Completed memory cannot be activated");
      const current = all.find((item) => item.status === "active");
      if (current?.id === id) return target;
      const previousPlan = current ? await this.planStorage.read(workspace, current.id) : undefined;
      let stateWriteAttempted = false;
      try {
        if (current) await this.settlePlan(workspace, current, decision);
        const now = new Date().toISOString();
        stateWriteAttempted = true;
        if (current) await this.tasks.storage.write(workspace, { ...current, status: "paused", updated_at: now });
        const active = { ...target, status: "active" as const, updated_at: now };
        await this.tasks.storage.write(workspace, active);
        return active;
      } catch (error) {
        if (stateWriteAttempted) {
          if (current) await this.tasks.storage.write(workspace, current);
          await this.tasks.storage.write(workspace, target);
        }
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async pause(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const target = await this.tasks.storage.read(workspace, id);
      if (target.status !== "active") throw new Error("Only the active memory can be paused");
      const previousPlan = await this.planStorage.read(workspace, id);
      let stateWriteAttempted = false;
      try {
        await this.settlePlan(workspace, target, decision);
        const state = { ...target, status: "paused" as const, updated_at: new Date().toISOString() };
        stateWriteAttempted = true;
        await this.tasks.storage.write(workspace, state); return state;
      } catch (error) {
        if (stateWriteAttempted) await this.tasks.storage.write(workspace, target);
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async complete(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const target = await this.tasks.storage.read(workspace, id);
      if (target.status === "completed") throw new Error("Memory is already completed");
      if (decision === "suspend") throw new Error("Completing memory requires abandoning an open plan");
      const previousPlan = await this.planStorage.read(workspace, id);
      let stateWriteAttempted = false;
      try {
        const plan = await this.settlePlan(workspace, target, decision);
        if (plan?.status === "suspended") throw new Error("Suspended plan must be abandoned before completing memory");
        const now = new Date().toISOString();
        const summary = target.outcome?.summary || target.confirmed_findings.at(-1) || target.objective || target.title;
        const state: TaskState = { ...target, status: "completed", outcome: {
          summary, limitations: target.blockers, evidence_refs: plan?.final_evidence?.verifications || [], completed_at: now }, updated_at: now };
        stateWriteAttempted = true;
        await this.tasks.storage.write(workspace, state); return state;
      } catch (error) {
        if (stateWriteAttempted) await this.tasks.storage.write(workspace, target);
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async phase(workspace: string, id: string, phase: string) {
    await this.registry.get(workspace);
    if (!["investigation", "implementation", "verification", "review"].includes(phase)) throw new Error("Invalid phase");
    return this.tasks.update(workspace, id, { phase });
  }

  async rollback(workspace: string, id: string, revision: number) {
    await this.registry.get(workspace);
    return this.tasks.rollbackSpec(workspace, id, revision, "Rollback initiated by local operator via control plane");
  }
}
