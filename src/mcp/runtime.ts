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
    if (input.action === "current") return { ...(await this.tasks.bootstrap(workspaceId)), active_plan: await this.plans.current(workspaceId) };
    const summary = (state: { id: string; title: string; status: string; phase: string; objective: string; updated_at: string }) =>
      ({ id: state.id, title: state.title, status: state.status, phase: state.phase, objective: state.objective, updated_at: state.updated_at });
    if (input.action === "list") return { memories: (await this.tasks.list(workspaceId)).map(summary) };
    if (input.action === "new") return summary(await this.tasks.create(workspaceId, String(input.title || ""), { objective: input.objective as string | undefined, phase: input.phase as string | undefined, activate: input.activate as boolean | undefined }));
    if (input.action === "activate") return summary(await this.tasks.activate(workspaceId, String(input.id || "")));
    if (input.action === "pause" || input.action === "complete") return summary(await this.tasks.transition(workspaceId, input.action === "pause" ? "paused" : "completed", input.id as string | undefined));
    if (input.action === "update") return summary(await this.tasks.update(workspaceId, input.id as string | undefined, { title: input.title as string | undefined,
      objective: input.objective as string | undefined, phase: input.phase as string | undefined, spec: input.spec as string | undefined }));
    if (input.action === "note") {
      if (!input.type || !input.text) throw new Error("memory note requires type and text");
      const state = await this.tasks.note(workspaceId, { type: input.type as never, text: String(input.text), confidence: input.confidence as never,
        repo: input.repo as string | undefined, file: input.file as string | undefined, symbol: input.symbol as string | undefined });
      return { saved: true, memory_id: state.id, note_type: input.type, updated_at: state.updated_at };
    }
    throw new Error(`Unsupported memory action: ${input.action}`);
  }

  async plan(input: PlanInput) {
    const workspaceId = await this.workspaceId();
    if (input.action === "current") return this.plans.current(workspaceId);
    if (input.action === "create") { await this.plans.create(workspaceId, input.steps); return this.plans.current(workspaceId); }
    if (input.action === "complete") return this.plans.complete(workspaceId);
    if (input.action === "revise") { await this.plans.revise(workspaceId, input.reason, input.current_step, input.future_steps); return this.plans.current(workspaceId); }
    throw new Error(`Unsupported plan action: ${(input as { action: string }).action}`);
  }
}
