import { WorkspaceRegistry } from "../workspace/registry.js";
import { TaskService } from "../task-state/service.js";
import { ContextBroker, configuredExternalBackends } from "../broker/service.js";
import { CodeBackend } from "../broker/code-backend.js";
import { GitBackend } from "../broker/git-backend.js";
import { parseContextRef } from "../broker/refs.js";
import { PlanService } from "../plan/service.js";
import { parseMemoryAction, type ContextFindInput, type ContextInspectInput, type MemoryInput, type PlanInput } from "./schemas.js";

export class ToolRuntime {
  clientName?: () => string | undefined;
  readonly registry = new WorkspaceRegistry();
  readonly tasks = new TaskService();
  readonly plans = new PlanService(undefined, this.tasks, this.registry);
  private brokerInstance?: Promise<ContextBroker>;

  private planClient(): "opencode" | "unknown" {
    return /opencode/i.test(this.clientName?.() || "") ? "opencode" : "unknown";
  }

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
    if (input.action === "current") {
      parseMemoryAction(input);
      const active = await this.tasks.current(workspaceId);
      if (!active) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      return { active: true, memory: await this.tasks.read(workspaceId, active.id), active_plan: await this.plans.current(workspaceId, this.planClient()) };
    }
    if (input.action === "note") {
      const value = parseMemoryAction(input) as { action: "note"; type: "observation" | "evidence" | "hypothesis" | "decision" | "question" | "blocker"; text: string;
        confidence: "low" | "medium" | "high"; evidence_refs: string[]; repo?: string; file?: string; symbol?: string };
      const state = await this.tasks.note(workspaceId, { type: value.type, text: value.text, confidence: value.confidence,
        evidence_refs: value.evidence_refs, repo: value.repo, file: value.file, symbol: value.symbol });
      return { saved: true, memory_id: state.id, record_id: state.records[0]!.id, record_status: state.records[0]!.status, note_type: input.type, updated_at: state.updated_at };
    }
    if (input.action === "resolve") {
      const value = parseMemoryAction(input) as { action: "resolve"; record_id: string; status: "observed" | "supported" | "confirmed" | "superseded" | "rejected" | "resolved" | "ruled_out"; reason: string; evidence_refs: string[] };
      const state = await this.tasks.resolve(workspaceId, value.record_id, value.status, value.reason, value.evidence_refs);
      const record = state.records.find((item) => item.id === input.record_id)!;
      return { memory_id: state.id, record_id: record.id, record_status: record.status, evidence_refs: record.evidence_refs, updated_at: record.updated_at };
    }
    if (input.action === "spec_set") {
      const value = parseMemoryAction(input) as { action: "spec_set"; summary: string; requirements: Array<{ id?: string; statement: string; kind: "behavior" | "constraint"; priority: "must" | "should" }> };
      return this.tasks.setSpec(workspaceId, { summary: value.summary, requirements: value.requirements });
    }
    throw new Error(`Unsupported memory action: ${(input as { action?: string }).action || "unknown"}`);
  }

  async plan(input: PlanInput) {
    const workspaceId = await this.workspaceId();
    if (input.action === "current") return this.plans.current(workspaceId, this.planClient());
    if (input.action === "create") { await this.plans.create(workspaceId, input.steps, input.exceptions); return this.plans.current(workspaceId, this.planClient()); }
    if (input.action === "complete") return this.plans.complete(workspaceId);
    if (input.action === "revise") { await this.plans.reviseOperations(workspaceId, input.reason, input.operations); return this.plans.current(workspaceId, this.planClient()); }
    if (input.action === "suspend") { await this.plans.transition(workspaceId, "suspended", input.reason); return this.plans.current(workspaceId, this.planClient()); }
    if (input.action === "reactivate") { await this.plans.transition(workspaceId, "active"); return this.plans.current(workspaceId, this.planClient()); }
    if (input.action === "abandon") { await this.plans.transition(workspaceId, "abandoned", input.reason); return this.plans.current(workspaceId, this.planClient()); }
    throw new Error(`Unsupported plan action: ${(input as { action: string }).action}`);
  }
}
