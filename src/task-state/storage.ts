import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { atomicWrite, purgeDirectory, readTextIfExists, withFileLock } from "../shared/fs.js";
import { structuredSpecSchema, taskStateSchema, type StructuredSpec, type TaskState } from "./schemas.js";
import { appPaths, assertSafeId } from "../workspace/paths.js";
import { projectTaskState } from "./projection.js";

export class TaskStorage {
  constructor(private readonly root = appPaths().workspaceDir) {}

  workspacePath(workspaceId: string): string { return path.join(this.root, assertSafeId(workspaceId), "tasks"); }
  taskPath(workspaceId: string, taskId: string): string { return path.join(this.workspacePath(workspaceId), assertSafeId(taskId)); }
  statePath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "state.json"); }
  findingsPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "findings.md"); }
  specPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "spec.md"); }
  specStatePath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "spec.json"); }
  specRevisionPath(workspaceId: string, taskId: string, revision: number): string { return path.join(this.taskPath(workspaceId, taskId), "spec-revisions", `${revision}.json`); }
  planPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "plan.json"); }
  transactionPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "transaction.json"); }

  private transactionFiles(workspaceId: string, taskId: string, extra: string[] = []): Record<string, string> {
    const files: Record<string, string> = {
      state: this.statePath(workspaceId, taskId), findings: this.findingsPath(workspaceId, taskId),
      spec: this.specPath(workspaceId, taskId), spec_state: this.specStatePath(workspaceId, taskId), plan: this.planPath(workspaceId, taskId),
    };
    for (const key of extra) {
      const match = /^spec_revision_([1-9][0-9]*)$/.exec(key);
      if (!match) throw new Error(`Unsupported transaction file key: ${key}`);
      files[key] = this.specRevisionPath(workspaceId, taskId, Number(match[1]));
    }
    return files;
  }

  private processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }

  async recoverTransaction(workspaceId: string, taskId: string): Promise<"none" | "committed" | "recovered"> {
    const journalPath = this.transactionPath(workspaceId, taskId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const raw = await readTextIfExists(journalPath); if (!raw) return "none";
      const journal = JSON.parse(raw) as { version?: number; status?: string; pid?: number; operation?: string; files?: Record<string, string | null>; extra?: string[] };
      if (journal.version !== 1 || !journal.status) throw new Error(`Invalid transaction journal for memory ${taskId}`);
      if (journal.status !== "pending") return journal.status === "recovered" ? "recovered" : "committed";
      if (typeof journal.pid === "number" && this.processAlive(journal.pid)) {
        await new Promise((resolve) => setTimeout(resolve, 20)); continue;
      }
      const files = this.transactionFiles(workspaceId, taskId, journal.extra || []);
      for (const [key, content] of Object.entries(journal.files || {})) {
        const target = files[key]; if (!target) throw new Error(`Invalid transaction snapshot key: ${key}`);
        if (content === null) await rm(target, { force: true }); else await atomicWrite(target, content);
      }
      await atomicWrite(journalPath, `${JSON.stringify({ ...journal, status: "recovered", recovered_at: new Date().toISOString() }, null, 2)}\n`);
      return "recovered";
    }
    throw new Error(`Memory ${taskId} has an active transaction; retry after the writer finishes`);
  }

  async transaction<T>(workspaceId: string, taskId: string, operation: string, action: () => Promise<T>, extra: string[] = []): Promise<T> {
    await this.recoverTransaction(workspaceId, taskId);
    const files = this.transactionFiles(workspaceId, taskId, extra); const snapshots: Record<string, string | null> = {};
    for (const [key, file] of Object.entries(files)) snapshots[key] = await readTextIfExists(file) ?? null;
    const journal = { version: 1, status: "pending", operation, pid: process.pid, started_at: new Date().toISOString(), extra, files: snapshots };
    await atomicWrite(this.transactionPath(workspaceId, taskId), `${JSON.stringify(journal, null, 2)}\n`);
    try {
      const result = await action();
      await atomicWrite(this.transactionPath(workspaceId, taskId), `${JSON.stringify({ version: 1, status: "committed", operation,
        committed_at: new Date().toISOString() }, null, 2)}\n`);
      return result;
    } catch (error) {
      for (const [key, content] of Object.entries(snapshots)) {
        const target = files[key]!; if (content === null) await rm(target, { force: true }); else await atomicWrite(target, content);
      }
      await atomicWrite(this.transactionPath(workspaceId, taskId), `${JSON.stringify({ ...journal, status: "recovered", recovered_at: new Date().toISOString() }, null, 2)}\n`);
      throw error;
    }
  }

  async list(workspaceId: string): Promise<TaskState[]> {
    return (await this.listWithDiagnostics(workspaceId)).memories;
  }

  async listWithDiagnostics(workspaceId: string): Promise<{ memories: TaskState[]; corrupt_entries: Array<{ id: string; error: string }> }> {
    let entries: string[];
    try { entries = await readdir(this.workspacePath(workspaceId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { memories: [], corrupt_entries: [] };
      throw error;
    }
    const corrupt_entries: Array<{ id: string; error: string }> = [];
    const states = await Promise.all(entries.sort().filter((id) => !id.startsWith(".")).map(async (id) => {
      try {
        if (await readTextIfExists(path.join(this.taskPath(workspaceId, id), ".deleted")) !== undefined
          && await readTextIfExists(this.statePath(workspaceId, id)) === undefined) return undefined;
        return await this.read(workspaceId, id);
      } catch (error) { corrupt_entries.push({ id, error: (error as Error).message }); return undefined; }
    }));
    return { memories: states.filter((state): state is TaskState => state !== undefined)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)), corrupt_entries };
  }

  async read(workspaceId: string, taskId: string): Promise<TaskState> {
    await this.recoverTransaction(workspaceId, taskId);
    const raw = await readTextIfExists(this.statePath(workspaceId, taskId));
    if (raw === undefined) throw new Error(`Unknown memory: ${taskId}`);
    const value = JSON.parse(raw) as Record<string, unknown>;
    const outcome = value.outcome as Record<string, unknown> | undefined;
    if (outcome && outcome.provenance_version !== 2) {
      value.outcome = { ...outcome, evidence_refs: [], modified_paths: [], verifications: [], provenance_version: 2,
        legacy_unclassified: outcome.legacy_unclassified || outcome.evidence_refs || [] };
    }
    return projectTaskState(taskStateSchema.parse(value));
  }

  async write(workspaceId: string, state: TaskState): Promise<void> {
    // Legacy persisted projections are ignored. Records are the sole current truth.
    const parsed = taskStateSchema.parse({ ...state, confirmed_findings: [], supported_findings: [], active_hypotheses: [],
      rejected_hypotheses: [], open_questions: [], blockers: [] });
    const target = this.statePath(workspaceId, state.id); const previous = await readTextIfExists(target);
    if (previous !== undefined) await atomicWrite(`${target}.backup`, previous);
    await atomicWrite(target, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async initialize(workspaceId: string, state: TaskState): Promise<void> {
    await this.transaction(workspaceId, state.id, "initialize", async () => {
      await this.write(workspaceId, state);
      await atomicWrite(this.findingsPath(workspaceId, state.id), `# Findings — ${state.title}\n\nUseful investigation knowledge only; no raw conversation or private reasoning.\n`);
      await atomicWrite(this.specPath(workspaceId, state.id), `# Specification — ${state.title}\n\nConfirmed design and implementation conclusions are recorded here.\n`);
    });
    await rm(path.join(this.taskPath(workspaceId, state.id), ".deleted"), { force: true });
  }

  async appendFinding(workspaceId: string, taskId: string, content: string): Promise<void> {
    const file = this.findingsPath(workspaceId, taskId);
    await withFileLock(file, async () => {
      const previous = await readTextIfExists(file) || "# Findings\n";
      await atomicWrite(file, `${previous.trimEnd()}\n\n${content.trim()}\n`);
    });
  }

  async writeSpec(workspaceId: string, taskId: string, content: string): Promise<void> {
    await atomicWrite(this.specPath(workspaceId, taskId), `${content.trim()}\n`);
  }

  async readSpec(workspaceId: string, taskId: string): Promise<string> {
    await this.recoverTransaction(workspaceId, taskId);
    return await readTextIfExists(this.specPath(workspaceId, taskId)) || "";
  }

  async readStructuredSpec(workspaceId: string, taskId: string): Promise<StructuredSpec | undefined> {
    await this.recoverTransaction(workspaceId, taskId);
    const raw = await readTextIfExists(this.specStatePath(workspaceId, taskId));
    return raw ? structuredSpecSchema.parse(JSON.parse(raw)) : undefined;
  }

  async readSpecRevision(workspaceId: string, taskId: string, revision: number): Promise<StructuredSpec> {
    await this.recoverTransaction(workspaceId, taskId);
    const raw = await readTextIfExists(this.specRevisionPath(workspaceId, taskId, revision));
    if (!raw) throw new Error(`Unknown specification revision: ${revision}`);
    return structuredSpecSchema.parse(JSON.parse(raw));
  }

  async writeStructuredSpec(workspaceId: string, taskId: string, spec: StructuredSpec): Promise<void> {
    const parsed = structuredSpecSchema.parse(spec); const json = `${JSON.stringify(parsed, null, 2)}\n`;
    const markdown = [`# Specification`, "", parsed.summary, "", `Revision: ${parsed.revision}`, "",
      ...parsed.requirements.map((item) => `- **${item.id}** [${item.priority}/${item.kind}] ${item.statement}`), ""].join("\n");
    await atomicWrite(this.specRevisionPath(workspaceId, taskId, parsed.revision), json);
    await atomicWrite(this.specStatePath(workspaceId, taskId), json);
    await atomicWrite(this.specPath(workspaceId, taskId), markdown);
  }

  async readPlan(workspaceId: string, taskId: string): Promise<string | undefined> {
    await this.recoverTransaction(workspaceId, taskId);
    return readTextIfExists(this.planPath(workspaceId, taskId));
  }

  async removeFinding(workspaceId: string, taskId: string, record: TaskState["records"][number]): Promise<void> {
    const file = this.findingsPath(workspaceId, taskId);
    const content = await readTextIfExists(file);
    if (content === undefined) return;
    const heading = `## ${record.kind[0]!.toUpperCase()}${record.kind.slice(1)} — ${record.created_at}\n\n${record.text}`;
    const start = content.indexOf(heading);
    if (start < 0) throw new Error(`Finding entry for ${record.id} was not found; note was not deleted`);
    const next = content.indexOf("\n\n## ", start + heading.length);
    const before = content.slice(0, start).trimEnd();
    const after = next < 0 ? "" : content.slice(next + 2).trim();
    await atomicWrite(file, `${before}${after ? `\n\n${after}` : ""}\n`);
  }

  async deleteSpec(workspaceId: string, taskId: string, title: string): Promise<void> {
    const revisions = path.join(this.taskPath(workspaceId, taskId), "spec-revisions");
    await purgeDirectory(revisions);
    await rm(this.specStatePath(workspaceId, taskId), { force: true });
    await rm(`${this.specStatePath(workspaceId, taskId)}.backup`, { force: true });
    await atomicWrite(this.specPath(workspaceId, taskId), `# Specification — ${title}\n\nConfirmed design and implementation conclusions are recorded here.\n`);
    await rm(`${this.specPath(workspaceId, taskId)}.backup`, { force: true });
  }

  async deleteTask(workspaceId: string, taskId: string): Promise<void> {
    const target = this.taskPath(workspaceId, taskId);
    await purgeDirectory(target);
    try { await readdir(target); await atomicWrite(path.join(target, ".deleted"), "deleted\n"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async workspaceLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.workspacePath(workspaceId), ".tasks"), action);
  }
}
