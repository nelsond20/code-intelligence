import { WorkspaceRegistry } from "../workspace/registry.js";
import { TaskService } from "../task-state/service.js";
import { ContextBroker, configuredExternalBackends } from "../broker/service.js";
import { CodeBackend } from "../broker/code-backend.js";
import { GitBackend } from "../broker/git-backend.js";
import { parseContextRef } from "../broker/refs.js";
import { PlanService } from "../plan/service.js";
import type { ContextFindInput, ContextInspectInput, MemoryInput, PlanInput } from "./schemas.js";

export class ToolRuntime {
  readonly registry = new WorkspaceRegistry();
  readonly tasks = new TaskService();
  readonly plans = new PlanService(undefined, this.tasks, this.registry);
  private brokerInstance?: Promise<ContextBroker>;

  async workspaceId(): Promise<string> {
    const configured = process.env.CODE_INTELLIGENCE_WORKSPACE?.trim();
    if (!configured) throw new Error("Code Intelligence MCP is not configured: set CODE_INTELLIGENCE_WORKSPACE to a registered workspace ID");
    const workspace = (await this.registry.list()).find((item) => item.id === configured);
    if (!workspace) throw new Error(`Code Intelligence MCP workspace is invalid: CODE_INTELLIGENCE_WORKSPACE=${configured} is not registered`);
    return workspace.id;
  }

  private async broker(): Promise<ContextBroker> {
    if (!this.brokerInstance) {
      const resolve = () => this.workspaceId();
      this.brokerInstance = configuredExternalBackends().then((external) =>
        new ContextBroker([new CodeBackend(this.registry, this.tasks, resolve), new GitBackend(this.registry, resolve), ...external]));
    }
    return this.brokerInstance;
  }
  async contextFind(input: ContextFindInput) {
    const workspace = await this.workspaceId();
    return (await this.broker()).find({ ...input, workspace });
  }
  async contextInspect(input: ContextInspectInput) {
    const workspaceId = await this.workspaceId();
    const result = await (await this.broker()).inspect({ ...input, workspace: workspaceId });
    const parsed = parseContextRef(input.ref);
    const record = result as { commit?: string; files?: Array<{ path?: string }>; changed_symbols?: string[] };
    await this.tasks.recordInspection(workspaceId, { ref: input.ref, repo: parsed.repo, commit: record.commit || parsed.commit,
      files: parsed.path ? [parsed.path] : record.files?.flatMap((file) => file.path ? [file.path] : []) || [],
      symbols: parsed.symbol ? [parsed.symbol] : record.changed_symbols || [] });
    return result;
  }
  async memory(input: MemoryInput) {
    const workspaceId = await this.workspaceId();
    const summary = (state: { id: string; title: string; status: string; phase: string; objective: string; updated_at: string }) =>
      ({ id: state.id, title: state.title, status: state.status, phase: state.phase, objective: state.objective, updated_at: state.updated_at });
    const withPlanStatus = async (state: Parameters<typeof summary>[0]) => {
      const raw = await this.tasks.storage.readPlan(workspaceId, state.id); let plan_status: string | undefined;
      try { plan_status = raw ? (JSON.parse(raw) as { status?: string }).status : undefined; } catch { plan_status = "corrupt"; }
      return { ...summary(state), plan_status };
    };
    if (input.action === "current") {
      const listed = await this.tasks.storage.listWithDiagnostics(workspaceId);
      const suspended_plans = (await Promise.all(listed.memories.map(withPlanStatus))).filter((item) => item.plan_status === "suspended");
      return { ...(await this.tasks.bootstrap(workspaceId)), active_plan: await this.plans.current(workspaceId), suspended_plans };
    }
    if (input.action === "list") { const listed = await this.tasks.storage.listWithDiagnostics(workspaceId); return {
      memories: await Promise.all(listed.memories.map(withPlanStatus)), corrupt_entries: listed.corrupt_entries }; }
    if (input.action === "read") return this.tasks.read(workspaceId, input.id);
    if (input.action === "search") return { results: await this.tasks.search(workspaceId, input.query, input.limit) };
    if (input.action === "new") return summary(await this.tasks.create(workspaceId, String(input.title || ""), { objective: input.objective as string | undefined, phase: input.phase as string | undefined, activate: input.activate as boolean | undefined }));
    if (input.action === "activate") return summary(await this.tasks.activate(workspaceId, String(input.id || "")));
    if (input.action === "pause") return summary(await this.tasks.transition(workspaceId, "paused", input.id));
    if (input.action === "complete") return summary(await this.tasks.complete(workspaceId, input.id, input.summary, input.limitations));
    if (input.action === "update") return summary(await this.tasks.update(workspaceId, input.id as string | undefined, { title: input.title as string | undefined,
      objective: input.objective as string | undefined, phase: input.phase as string | undefined, spec: input.spec as string | undefined }));
    if (input.action === "note") {
      const state = await this.tasks.note(workspaceId, { type: input.type, text: input.text, confidence: input.confidence,
        evidence_refs: input.evidence_refs, repo: input.repo, file: input.file, symbol: input.symbol });
      return { saved: true, memory_id: state.id, note_type: input.type, updated_at: state.updated_at };
    }
    if (input.action === "resolve") return summary(await this.tasks.resolve(workspaceId, input.record_id, input.status, input.reason, input.evidence_refs));
    if (input.action === "spec_replace") return this.tasks.replaceSpec(workspaceId, input.id, { summary: input.summary, requirements: input.requirements }, input.reason);
    if (input.action === "spec_patch") return this.tasks.patchSpec(workspaceId, input.id, input.reason, input.operations);
    if (input.action === "spec_rollback") return this.tasks.rollbackSpec(workspaceId, input.id, input.revision, input.reason);
    throw new Error(`Unsupported memory action: ${(input as { action?: string }).action || "unknown"}`);
  }

  async plan(input: PlanInput) {
    const workspaceId = await this.workspaceId();
    if (input.action === "current") return this.plans.current(workspaceId);
    if (input.action === "create") { await this.plans.create(workspaceId, input.steps, input.exceptions); return this.plans.current(workspaceId); }
    if (input.action === "complete") return this.plans.complete(workspaceId);
    if (input.action === "revise") { await this.plans.reviseOperations(workspaceId, input.reason, input.operations); return this.plans.current(workspaceId); }
    if (input.action === "suspend") { await this.plans.transition(workspaceId, "suspended", input.reason); return this.plans.current(workspaceId); }
    if (input.action === "reactivate") { await this.plans.transition(workspaceId, "active"); return this.plans.current(workspaceId); }
    if (input.action === "abandon") { await this.plans.transition(workspaceId, "abandoned", input.reason); return this.plans.current(workspaceId); }
    throw new Error(`Unsupported plan action: ${(input as { action: string }).action}`);
  }
}
