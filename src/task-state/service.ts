import { taskNoteSchema, taskUpdateSchema, type TaskNote, type TaskState, type TaskUpdate } from "./schemas.js";
import { TaskStorage } from "./storage.js";
import { renderTaskContext, taskBootstrap } from "./context-renderer.js";
import { slugify } from "../workspace/paths.js";

function uniquePush(values: string[], value: string, max = 50): string[] {
  return [value, ...values.filter((item) => item !== value)].slice(0, max);
}

export class TaskService {
  constructor(readonly storage = new TaskStorage()) {}

  async list(workspaceId: string): Promise<TaskState[]> { return this.storage.list(workspaceId); }
  async current(workspaceId: string): Promise<TaskState | undefined> {
    return (await this.list(workspaceId)).find((task) => task.status === "active");
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
      if (options.activate !== false) await this.pauseActive(workspaceId, tasks);
      const now = new Date().toISOString();
      const state: TaskState = {
        schema_version: 1, id, title: title.trim(), status: options.activate === false ? "paused" : "active",
        phase: options.phase || "investigation", objective: options.objective || "",
        confirmed_findings: [], active_hypotheses: [], rejected_hypotheses: [], open_questions: [], blockers: [],
        relevant_files: [], relevant_symbols: [], inspected_refs: [], inspected_commits: [], created_at: now, updated_at: now,
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
      if (target.status === "completed") throw new Error("Completed tasks cannot be activated; update their status is intentionally unsupported");
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
      const state = { ...target, status, updated_at: new Date().toISOString() };
      await this.storage.write(workspaceId, state);
      return state;
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
      await this.storage.write(workspaceId, state);
      if (spec !== undefined) await this.storage.writeSpec(workspaceId, state.id, spec);
      return state;
    });
  }

  async note(workspaceId: string, input: TaskNote): Promise<TaskState> {
    const note = taskNoteSchema.parse(input);
    return this.storage.workspaceLock(workspaceId, async () => {
      const current = await this.current(workspaceId);
      if (!current) throw new Error("No active memory");
      const state: TaskState = structuredClone(current);
      const detail = [note.repo && `repo=${note.repo}`, note.file && `file=${note.file}`, note.symbol && `symbol=${note.symbol}`].filter(Boolean).join(", ");
      const heading = note.type.replaceAll("_", " ").replace(/^./, (v) => v.toUpperCase());
      await this.storage.appendFinding(workspaceId, state.id, `## ${heading} — ${new Date().toISOString()}\n\n${note.text}${detail ? `\n\nContext: ${detail}` : ""}`);
      if (note.type === "observation" || note.type === "evidence" || note.type === "decision") state.confirmed_findings = uniquePush(state.confirmed_findings, note.text);
      if (note.type === "hypothesis") {
        state.active_hypotheses = [{ id: `hyp-${Date.now().toString(36)}`, text: note.text, confidence: note.confidence }, ...state.active_hypotheses.filter((h) => h.text !== note.text)].slice(0, 30);
      }
      if (note.type === "hypothesis_rejected") {
        const existing = state.active_hypotheses.find((h) => h.text === note.text);
        state.active_hypotheses = state.active_hypotheses.filter((h) => h.text !== note.text);
        state.rejected_hypotheses = [{ id: existing?.id || `hyp-${Date.now().toString(36)}`, text: note.text, confidence: existing?.confidence || note.confidence }, ...state.rejected_hypotheses].slice(0, 30);
      }
      if (note.type === "question") state.open_questions = uniquePush(state.open_questions, note.text);
      if (note.type === "blocker") state.blockers = uniquePush(state.blockers, note.text);
      if (note.repo && note.file && !state.relevant_files.some((v) => v.repo === note.repo && v.path === note.file)) state.relevant_files.unshift({ repo: note.repo, path: note.file });
      if (note.symbol) state.relevant_symbols = uniquePush(state.relevant_symbols, note.symbol);
      state.updated_at = new Date().toISOString();
      await this.storage.write(workspaceId, state);
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
        if (facts.repo && !state.relevant_files.some((item) => item.repo === facts.repo && item.path === file)) state.relevant_files.unshift({ repo: facts.repo, path: file });
      }
      for (const symbol of facts.symbols || []) state.relevant_symbols = uniquePush(state.relevant_symbols, symbol, 50);
      state.relevant_files = state.relevant_files.slice(0, 50);
      state.updated_at = new Date().toISOString();
      await this.storage.write(workspaceId, state);
    });
  }
}
