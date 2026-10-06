import { desiredRequirementInput, memoryRecordStatusSchema, structuredSpecSchema, taskNoteSchema, taskUpdateSchema, type MemoryRecordStatus, type StructuredSpec, type TaskNote, type TaskState, type TaskUpdate } from "./schemas.js";
import { z } from "zod";
import { TaskStorage } from "./storage.js";
import { renderTaskContext, taskBootstrap } from "./context-renderer.js";
import { slugify } from "../workspace/paths.js";
import { planStateSchema } from "../plan/schemas.js";
import { planBindingStale } from "../plan/binding.js";
import { reviewReceiptCurrent } from "../plan/review-state.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

function uniquePush(values: string[], value: string, max = 50): string[] {
  return [value, ...values.filter((item) => item !== value)].slice(0, max);
}

export class TaskService {
  constructor(readonly storage = new TaskStorage()) {}

  async list(workspaceId: string): Promise<TaskState[]> { return this.storage.list(workspaceId); }
  async current(workspaceId: string): Promise<TaskState | undefined> {
    return (await this.list(workspaceId)).find((task) => task.status === "active" && !task.archived_at);
  }

  async bootstrap(workspaceId: string) {
    const state = await this.current(workspaceId);
    if (!state) return { active: false as const };
    return { active: true as const, memory: taskBootstrap(state, this.storage.findingsPath(workspaceId, state.id), this.storage.specPath(workspaceId, state.id)) };
  }

  async create(workspaceId: string, title: string, options: { objective?: string; phase?: string; activate?: boolean } = {}): Promise<TaskState> {
    if (!title.trim()) throw new Error("Memory title is required");
    return this.storage.workspaceLock(workspaceId, async () => {
      const tasks = await this.list(workspaceId);
      const base = slugify(title);
      let id = base;
      let suffix = 2;
      while (tasks.some((task) => task.id === id)) id = `${base}-${suffix++}`;
      if (options.activate !== false) {
        for (const task of tasks.filter((item) => item.status === "active")) await this.assertMayLeave(workspaceId, task);
        await this.pauseActive(workspaceId, tasks);
      }
      const now = new Date().toISOString();
      const state: TaskState = {
        schema_version: 2, id, title: title.trim(), status: options.activate === false ? "paused" : "active",
        phase: options.phase || "investigation", objective: options.objective || "",
        confirmed_findings: [], active_hypotheses: [], rejected_hypotheses: [], open_questions: [], blockers: [],
        relevant_files: [], relevant_symbols: [], inspected_refs: [], inspected_files: [], inspected_symbols: [], inspected_commits: [], records: [], created_at: now, updated_at: now,
      };
      await this.storage.initialize(workspaceId, state);
      return state;
    });
  }

  private async pauseActive(workspaceId: string, tasks = [] as TaskState[]): Promise<void> {
    const all = tasks.length ? tasks : await this.list(workspaceId);
    for (const task of all.filter((item) => item.status === "active")) {
      await this.storage.write(workspaceId, { ...task, status: "paused", updated_at: new Date().toISOString() });
    }
  }

  async activate(workspaceId: string, taskId: string): Promise<TaskState> {
    return this.storage.workspaceLock(workspaceId, async () => {
      const tasks = await this.list(workspaceId);
      const target = tasks.find((task) => task.id === taskId);
      if (!target) throw new Error(`Unknown memory: ${taskId}`);
      if (target.archived_at) throw new Error("Restore this archived memory before activating it");
      if (target.status === "completed") throw new Error("Completed tasks cannot be activated; update their status is intentionally unsupported");
      for (const task of tasks.filter((item) => item.status === "active" && item.id !== target.id)) await this.assertMayLeave(workspaceId, task);
      await this.pauseActive(workspaceId, tasks);
      const state = { ...target, status: "active" as const, updated_at: new Date().toISOString() };
      await this.storage.write(workspaceId, state);
      return state;
    });
  }

  async transition(workspaceId: string, status: "paused" | "completed", taskId?: string): Promise<TaskState> {
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId);
      if (!target) throw new Error("No active memory");
      await this.assertMayLeave(workspaceId, target, status === "completed");
      const state = { ...target, status, updated_at: new Date().toISOString() };
      await this.storage.write(workspaceId, state);
      return state;
    });
  }

  async complete(workspaceId: string, taskId?: string, summary?: string, limitations: string[] = []): Promise<TaskState> {
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId); if (!target) throw new Error("No active memory");
      await this.assertMayLeave(workspaceId, target, true);
      const rawPlan = await this.storage.readPlan(workspaceId, target.id);
      const plan = rawPlan ? JSON.parse(rawPlan) as { status?: string; final_evidence?: { covered_requirements?: string[]; modified_paths?: string[]; verifications?: string[] } } : undefined;
      if (plan && plan.status !== "completed" && plan.status !== "abandoned") throw new Error("Memory plan is not terminal");
      if (!plan?.final_evidence && !summary?.trim()) throw new Error("Completing memory without final plan evidence requires an explicit outcome summary");
      const evidence = plan?.final_evidence;
      const outcomeSummary = summary?.trim() || `Covered ${(evidence?.covered_requirements || []).join(", ")}; changed ${(evidence?.modified_paths || []).join(", ")}; verified ${(evidence?.verifications || []).join(", ")}.`;
      const now = new Date().toISOString(); const state: TaskState = { ...target, status: "completed", outcome: {
        summary: outcomeSummary, limitations, evidence_refs: [...(evidence?.modified_paths || []), ...(evidence?.verifications || [])], completed_at: now }, updated_at: now };
      await this.storage.write(workspaceId, state); return state;
    });
  }

  async update(workspaceId: string, taskId: string | undefined, input: TaskUpdate): Promise<TaskState> {
    const update = taskUpdateSchema.parse(input);
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId);
      if (!target) throw new Error("No active memory");
      const { spec, ...stateUpdate } = update;
      const definedUpdate = Object.fromEntries(Object.entries(stateUpdate).filter(([, value]) => value !== undefined));
      const state = { ...target, ...definedUpdate, updated_at: new Date().toISOString() } as TaskState;
      const previous = spec === undefined ? undefined : await this.storage.readStructuredSpec(workspaceId, target.id);
      const structured = spec === undefined ? undefined : structuredSpecSchema.parse({ revision: (previous?.revision || 0) + 1, summary: spec,
        requirements: [{ id: "R1", statement: spec, kind: "behavior", priority: "must" }], reason: "legacy update compatibility", created_at: new Date().toISOString() });
      await this.storage.transaction(workspaceId, state.id, "update-memory", async () => {
        await this.storage.write(workspaceId, state);
        if (structured) await this.storage.writeStructuredSpec(workspaceId, state.id, structured);
      }, structured ? [`spec_revision_${structured.revision}`] : []);
      return state;
    });
  }

  async note(workspaceId: string, input: TaskNote): Promise<TaskState> {
    const note = taskNoteSchema.parse(input);
    return this.storage.workspaceLock(workspaceId, async () => {
      const current = await this.current(workspaceId);
      if (!current) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      const state: TaskState = structuredClone(current);
      for (const ref of note.evidence_refs) if (!state.inspected_refs.includes(ref)) throw new Error(`Evidence ref has not been inspected in this memory: ${ref}`);
      const now = new Date().toISOString();
      const recordKind = note.type === "hypothesis_rejected" ? "hypothesis" : note.type;
      if (note.type === "hypothesis_rejected") throw new Error("Reject hypotheses with memory.resolve and the server-owned record id");
      const nextRecordId = state.next_record_id || Math.max(0, ...state.records.map((item) => Number(item.id.slice(1)) || 0)) + 1;
      const record = { id: `M${nextRecordId}`, kind: recordKind, text: note.text,
        status: note.evidence_refs.length ? "supported" as const : "observed" as const, confidence: note.confidence,
        evidence_refs: note.evidence_refs, repo: note.repo, file: note.file, symbol: note.symbol, created_at: now, updated_at: now };
      state.records.unshift(record);
      state.next_record_id = nextRecordId + 1;
      const detail = [note.repo && `repo=${note.repo}`, note.file && `file=${note.file}`, note.symbol && `symbol=${note.symbol}`].filter(Boolean).join(", ");
      const heading = note.type.replaceAll("_", " ").replace(/^./, (v) => v.toUpperCase());
      if ((note.type === "observation" || note.type === "evidence" || note.type === "decision") && note.evidence_refs.length) state.confirmed_findings = uniquePush(state.confirmed_findings, note.text);
      if (note.type === "hypothesis") {
        state.active_hypotheses = [{ id: `hyp-${Date.now().toString(36)}`, text: note.text, confidence: note.confidence }, ...state.active_hypotheses.filter((h) => h.text !== note.text)].slice(0, 30);
      }
      if (note.type === "question") state.open_questions = uniquePush(state.open_questions, note.text);
      if (note.type === "blocker") state.blockers = uniquePush(state.blockers, note.text);
      if (note.repo && note.file) state.relevant_files = [{ repo: note.repo, path: note.file }, ...state.relevant_files.filter((v) => v.repo !== note.repo || v.path !== note.file)];
      if (note.symbol) state.relevant_symbols = uniquePush(state.relevant_symbols, note.symbol);
      state.updated_at = now;
      await this.storage.transaction(workspaceId, state.id, "append-memory-note", async () => {
        await this.storage.appendFinding(workspaceId, state.id, `## ${heading} — ${now}\n\n${note.text}${detail ? `\n\nContext: ${detail}` : ""}`);
        await this.storage.write(workspaceId, state);
      });
      return state;
    });
  }

  async context(workspaceId: string, maxTokens = 3000): Promise<string> {
    const state = await this.current(workspaceId);
    if (!state) return "No active memory.";
    return renderTaskContext(state, this.storage.findingsPath(workspaceId, state.id), this.storage.specPath(workspaceId, state.id), maxTokens);
  }

  async recordInspection(workspaceId: string, facts: { ref: string; repo?: string; commit?: string; files?: string[]; symbols?: string[] }): Promise<void> {
    await this.storage.workspaceLock(workspaceId, async () => {
      const state = await this.current(workspaceId);
      if (!state) return;
      state.inspected_refs = uniquePush(state.inspected_refs, facts.ref, 50);
      if (facts.repo && facts.commit) {
        state.inspected_commits = [{ repo: facts.repo, commit: facts.commit }, ...state.inspected_commits.filter((item) => item.repo !== facts.repo || item.commit !== facts.commit)].slice(0, 30);
      }
      for (const file of facts.files || []) {
        if (facts.repo && !state.inspected_files.some((item) => item.repo === facts.repo && item.path === file)) state.inspected_files.unshift({ repo: facts.repo, path: file });
      }
      for (const symbol of facts.symbols || []) state.inspected_symbols = uniquePush(state.inspected_symbols, symbol, 100);
      state.relevant_files = state.relevant_files.slice(0, 50);
      state.inspected_files = state.inspected_files.slice(0, 100);
      state.inspected_symbols = state.inspected_symbols.slice(0, 100);
      state.updated_at = new Date().toISOString();
      await this.storage.write(workspaceId, state);
    });
  }

  async replaceSpec(workspaceId: string, taskId: string | undefined,
    input: { summary: string; requirements: Array<{ statement: string; kind: "behavior" | "constraint"; priority: "must" | "should" }> }, reason?: string): Promise<StructuredSpec> {
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId);
      if (!target) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      const previous = await this.storage.readStructuredSpec(workspaceId, target.id);
      if (previous && !reason?.trim()) throw new Error("Replacing an existing specification requires a reason");
      const now = new Date().toISOString();
      const spec = structuredSpecSchema.parse({ revision: (previous?.revision || 0) + 1, summary: input.summary,
        requirements: input.requirements.map((item, index) => ({ ...item, id: `R${index + 1}` })), reason, created_at: now });
      await this.storage.transaction(workspaceId, target.id, "replace-specification", () => this.storage.writeStructuredSpec(workspaceId, target.id, spec),
        [`spec_revision_${spec.revision}`]);
      return spec;
    });
  }

  async setSpec(workspaceId: string, input: { summary: string; requirements: z.input<typeof desiredRequirementInput>[] }) {
    const desired = z.object({ summary: z.string().trim().min(1).max(50_000), requirements: z.array(desiredRequirementInput).min(1).max(500) }).strict().parse(input);
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = await this.current(workspaceId);
      if (!target) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      const previous = await this.storage.readStructuredSpec(workspaceId, target.id);
      const existing = new Map(previous?.requirements.map((item) => [item.id, item]) || []);
      const seen = new Set<string>();
      let next = 1;
      if (previous) for (let revision = 1; revision <= previous.revision; revision++) {
        const historical = await this.storage.readSpecRevision(workspaceId, target.id, revision);
        next = Math.max(next, ...historical.requirements.map((item) => Number(item.id.slice(1)) + 1));
      }
      const requirements = desired.requirements.map((item) => {
        if (item.id) {
          if (seen.has(item.id)) throw new Error(`Duplicate requirement: ${item.id}`);
          if (!existing.has(item.id)) throw new Error(`Unknown requirement in active memory: ${item.id}`);
          seen.add(item.id); return { ...item, id: item.id };
        }
        const id = `R${next++}`; seen.add(id); return { ...item, id };
      });
      const added = requirements.filter((item) => !existing.has(item.id)).map((item) => item.id);
      const updated = requirements.filter((item) => {
        const old = existing.get(item.id);
        return old && (old.statement !== item.statement || old.kind !== item.kind || old.priority !== item.priority);
      }).map((item) => item.id);
      const removed = [...existing.keys()].filter((id) => !seen.has(id));
      const changed = !previous || previous.summary !== desired.summary || added.length > 0 || updated.length > 0 || removed.length > 0
        || JSON.stringify(previous.requirements.map((item) => item.id)) !== JSON.stringify(requirements.map((item) => item.id));
      const diff = { added, updated, removed };
      if (!changed && previous) return { spec: previous, revision: previous.revision, diff, changed: false };
      const spec = structuredSpecSchema.parse({ revision: (previous?.revision || 0) + 1, summary: desired.summary, requirements,
        reason: "Declarative specification update", created_at: new Date().toISOString() });
      await this.storage.transaction(workspaceId, target.id, "set-specification", () => this.storage.writeStructuredSpec(workspaceId, target.id, spec),
        [`spec_revision_${spec.revision}`]);
      return { spec, revision: spec.revision, diff, changed: true };
    });
  }

  async patchSpec(workspaceId: string, taskId: string | undefined, reason: string,
    operations: Array<{ op: "add"; requirement: { statement: string; kind: "behavior" | "constraint"; priority: "must" | "should" } }
      | { op: "update"; id: string; requirement: { statement?: string; kind?: "behavior" | "constraint"; priority?: "must" | "should" } }
      | { op: "remove"; id: string }>): Promise<StructuredSpec> {
    if (!reason.trim()) throw new Error("Specification patch requires a reason");
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId); if (!target) throw new Error("No active memory");
      const previous = await this.storage.readStructuredSpec(workspaceId, target.id); if (!previous) throw new Error("No structured specification to patch");
      const requirements = structuredClone(previous.requirements); let next = Math.max(...requirements.map((item) => Number(item.id.slice(1))), 0) + 1;
      for (const operation of operations) {
        if (operation.op === "add") requirements.push({ id: `R${next++}`, ...operation.requirement });
        else {
          const index = requirements.findIndex((item) => item.id === operation.id); if (index < 0) throw new Error(`Unknown requirement: ${operation.id}`);
          if (operation.op === "remove") requirements.splice(index, 1); else requirements[index] = { ...requirements[index]!, ...operation.requirement };
        }
      }
      const spec = structuredSpecSchema.parse({ ...previous, revision: previous.revision + 1, requirements, reason, created_at: new Date().toISOString() });
      await this.storage.transaction(workspaceId, target.id, "patch-specification", () => this.storage.writeStructuredSpec(workspaceId, target.id, spec),
        [`spec_revision_${spec.revision}`]);
      return spec;
    });
  }

  async rollbackSpec(workspaceId: string, taskId: string | undefined, revision: number, reason: string): Promise<StructuredSpec> {
    if (!reason.trim()) throw new Error("Specification rollback requires a reason");
    return this.storage.workspaceLock(workspaceId, async () => {
      const target = taskId ? await this.storage.read(workspaceId, taskId) : await this.current(workspaceId); if (!target) throw new Error("No active memory");
      const current = await this.storage.readStructuredSpec(workspaceId, target.id); if (!current) throw new Error("No structured specification to roll back");
      const selected = await this.storage.readSpecRevision(workspaceId, target.id, revision);
      const restored = structuredSpecSchema.parse({ ...selected, revision: current.revision + 1,
        reason: `Rollback to revision ${revision}: ${reason.trim()}`, created_at: new Date().toISOString() });
      await this.storage.transaction(workspaceId, target.id, "rollback-specification",
        () => this.storage.writeStructuredSpec(workspaceId, target.id, restored), [`spec_revision_${restored.revision}`]);
      return restored;
    });
  }

  async resolve(workspaceId: string, recordId: string, status: MemoryRecordStatus, reason: string, evidenceRefs: string[] = []): Promise<TaskState> {
    const resolvedStatus = memoryRecordStatusSchema.parse(status);
    return this.storage.workspaceLock(workspaceId, async () => {
      const state = await this.current(workspaceId); if (!state) throw new Error("NO_ACTIVE_MEMORY: Memory selection is controlled by the operator in the local control plane.");
      const record = state.records.find((item) => item.id === recordId); if (!record) throw new Error(`Unknown memory record: ${recordId}`);
      const refs = [...new Set([...record.evidence_refs, ...evidenceRefs])];
      for (const ref of refs) if (!state.inspected_refs.includes(ref)) throw new Error(`Evidence ref has not been inspected in this memory: ${ref}`);
      if (resolvedStatus === "confirmed" && refs.length === 0) throw new Error("Confirming a technical record requires inspected evidence");
      record.status = resolvedStatus; record.reason = reason.trim(); record.evidence_refs = refs; record.updated_at = new Date().toISOString();
      if (resolvedStatus === "confirmed") state.confirmed_findings = uniquePush(state.confirmed_findings, record.text);
      if (record.kind === "hypothesis" && ["rejected", "superseded", "ruled_out"].includes(resolvedStatus)) {
        state.active_hypotheses = state.active_hypotheses.filter((item) => item.text !== record.text);
        state.rejected_hypotheses.unshift({ id: record.id, text: record.text, confidence: record.confidence, reason: record.reason });
      }
      if (record.kind === "question" && resolvedStatus === "resolved") state.open_questions = state.open_questions.filter((item) => item !== record.text);
      if (record.kind === "blocker" && resolvedStatus === "resolved") state.blockers = state.blockers.filter((item) => item !== record.text);
      state.updated_at = record.updated_at; await this.storage.write(workspaceId, state); return state;
    });
  }

  async read(workspaceId: string, taskId: string): Promise<TaskState & { spec?: StructuredSpec }> {
    const state = await this.storage.read(workspaceId, taskId); return { ...state, spec: await this.storage.readStructuredSpec(workspaceId, taskId) };
  }

  async search(workspaceId: string, query: string, limit = 10) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []; const matches: Array<{ memory_id: string; title: string; snippet: string; score: number }> = [];
    for (const state of await this.list(workspaceId)) {
      const spec = await this.storage.readStructuredSpec(workspaceId, state.id);
      const texts = [state.objective, spec?.summary || "", ...state.records.map((item) => item.text), state.outcome?.summary || ""];
      for (const text of texts) { const score = terms.filter((term) => text.toLowerCase().includes(term)).length; if (score) matches.push({ memory_id: state.id, title: state.title, snippet: text.slice(0, 1000), score }); }
    }
    return matches.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id)).slice(0, Math.max(1, Math.min(20, limit)));
  }

  private async planStatus(workspaceId: string, memoryId: string): Promise<string | undefined> {
    const raw = await this.storage.readPlan(workspaceId, memoryId);
    if (!raw) return undefined;
    try { return (JSON.parse(raw) as { status?: string }).status; }
    catch { throw new Error(`Plan state for memory ${memoryId} is corrupt`); }
  }

  private async assertMayLeave(workspaceId: string, memory: TaskState, completing = false): Promise<void> {
    const status = await this.planStatus(workspaceId, memory.id);
    if (completing && status && status !== "completed") throw new Error(`PLAN_REVIEW_REQUIRED: Memory ${memory.id} cannot complete until its plan and final review are completed`);
    if (completing && status === "completed") {
      const raw = await this.storage.readPlan(workspaceId, memory.id);
      const plan = raw ? planStateSchema.parse(JSON.parse(raw)) : undefined;
      if (plan && await planBindingStale(this.storage, workspaceId, plan)) {
        throw new Error(`PLAN_STALE: Memory ${memory.id} is bound to an older specification`);
      }
      if (plan && !(await reviewReceiptCurrent(workspaceId, plan, new WorkspaceRegistry()))) {
        throw new Error(`PLAN_REVIEW_REQUIRED: Memory ${memory.id} needs a current cumulative code-review-and-quality receipt`);
      }
    }
    if (status === "active" || status === "final_review") throw new Error(`Memory ${memory.id} has an ${status} plan; suspend, complete, or abandon the plan first`);
    if (completing && status === "suspended") throw new Error(`Memory ${memory.id} has a suspended plan; complete or abandon the plan first`);
  }
}
