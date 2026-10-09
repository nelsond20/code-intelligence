import { WorkspaceRegistry } from "../workspace/registry.js";
import { TaskService } from "../task-state/service.js";
import { ContextBroker, configuredExternalBackends } from "../broker/service.js";
import { CodeBackend } from "../broker/code-backend.js";
import { GitBackend } from "../broker/git-backend.js";
import { parseContextRef } from "../broker/refs.js";
import { PlanService } from "../plan/service.js";
import { parseMemoryAction, type ContextFindInput, type ContextInspectInput, type MemoryInput, type PlanInput } from "./schemas.js";
import { assertMemoryActionAllowed, deriveStage } from "../orchestration/stage.js";
import { pageMemoryCurrent } from "./memory-page.js";
import { pagePlanCurrent } from "./plan-page.js";

export class PlanCreateFailure extends Error {
  constructor(readonly phase: "create" | "read_created_plan", cause: unknown) {
    super(`plan.create failed during ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export class ToolRuntime {
  clientName?: () => string | undefined;
  readonly registry = new WorkspaceRegistry();
  readonly tasks = new TaskService();
  readonly plans = new PlanService(undefined, this.tasks, this.registry);
  private brokerInstance?: Promise<ContextBroker>;

  private planClient(): "opencode" | "unknown" {
    return /opencode/i.test(this.clientName?.() || "") ? "opencode" : "unknown";
  }

  private async withStage<T extends object>(workspaceId: string, data: T) {
    return { ...data, ...await deriveStage(this.plans, workspaceId) };
  }

  private compactPlanResponse<T extends { step?: { writes: Array<string | { path: string }> } }>(value: T): T {
    if (!value.step) return value;
    const { id, title, objective, required_checks, modified_paths } = value.step as T["step"] & {
      id: string; title: string; objective: string; required_checks: unknown; modified_paths: unknown };
    return { ...value, step: { id, title, objective,
      writes: value.step.writes.map((write) => typeof write === "string" ? write : write.path),
      required_checks, modified_paths } } as T;
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
    const action = parseMemoryAction(input);
    assertMemoryActionAllowed(action.action, await deriveStage(this.plans, workspaceId));
    if (input.action === "current") {
      const page = action as { section?: "records" | "requirements" | "summary" | "metadata" | "item"; offset?: number; state_token?: string; item_id?: string };
      const active = await this.tasks.current(workspaceId);
      if (!active) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      const { id: _internalMemoryId, ...memory } = await this.tasks.read(workspaceId, active.id);
      if (active.spec_archived_at) delete memory.spec;
      return pageMemoryCurrent(await this.withStage(workspaceId, { active: true,
        memory, active_plan: this.compactPlanResponse(await this.plans.current(workspaceId, this.planClient())) }), page, active.id);
    }
    if (input.action === "note") {
      const value = action as { action: "note"; type: "observation" | "evidence" | "hypothesis" | "decision" | "question" | "blocker"; text: string;
        confidence: "low" | "medium" | "high"; evidence_refs: string[]; repo?: string; file?: string; symbol?: string };
      const state = await this.tasks.note(workspaceId, { type: value.type, text: value.text, confidence: value.confidence,
        evidence_refs: value.evidence_refs, repo: value.repo, file: value.file, symbol: value.symbol });
      return this.withStage(workspaceId, { saved: true, record_id: state.records[0]!.id, record_id_kind: "memory_record", is_evidence_ref: false,
        record_status: state.records[0]!.status, note_type: input.type, updated_at: state.updated_at });
    }
    if (input.action === "resolve") {
      const value = action as { action: "resolve"; record_id: string; status: "observed" | "supported" | "confirmed" | "superseded" | "rejected" | "resolved" | "ruled_out"; reason: string; evidence_refs: string[] };
      const state = await this.tasks.resolve(workspaceId, value.record_id, value.status, value.reason, value.evidence_refs);
      const record = state.records.find((item) => item.id === input.record_id)!;
      return this.withStage(workspaceId, { record_id: record.id, record_id_kind: "memory_record", is_evidence_ref: false,
        record_status: record.status, evidence_refs: record.evidence_refs, updated_at: record.updated_at });
    }
    if (input.action === "spec_set") {
      const value = action as { action: "spec_set"; summary: string; requirements: Array<{ id?: string; statement: string; kind: "behavior" | "constraint"; priority: "must" | "should" }> };
      const result = await this.tasks.setSpec(workspaceId, { summary: value.summary, requirements: value.requirements });
      const response = await this.withStage(workspaceId, result);
      if (Buffer.byteLength(JSON.stringify(response)) <= 18_000) return response;
      return { ...response, spec: { ...result.spec, summary: result.spec.summary.slice(0, 1_000), requirements: [],
        requirement_ids: result.spec.requirements.map((item) => item.id) },
        continuation: { next_action: "Call memory.current to obtain a state_token, then page section=requirements or summary" } };
    }
    throw new Error(`Unsupported memory action: ${(input as { action?: string }).action || "unknown"}`);
  }

  async plan(input: PlanInput) {
    const workspaceId = await this.workspaceId();
    if (input.action === "current") return pagePlanCurrent(this.compactPlanResponse(await this.withStage(workspaceId, await this.plans.current(workspaceId, this.planClient()))), input);
    if (input.action === "create") {
      try { await this.plans.createCompact(workspaceId, input.steps); }
      catch (error) { throw new PlanCreateFailure("create", error); }
      try { return pagePlanCurrent(this.compactPlanResponse(await this.withStage(workspaceId, await this.plans.current(workspaceId, this.planClient()))), {}); }
      catch (error) { throw new PlanCreateFailure("read_created_plan", error); }
    }
    if (input.action === "complete_current") return this.withStage(workspaceId, await this.plans.completeCurrent(workspaceId));
    if (input.action === "revise_current") { await this.plans.reviseCurrentCompact(workspaceId, input.reason, input.step);
      return pagePlanCurrent(this.compactPlanResponse(await this.withStage(workspaceId, await this.plans.current(workspaceId, this.planClient()))), {}); }
    throw new Error(`Unsupported plan action: ${(input as { action: string }).action}`);
  }
}
