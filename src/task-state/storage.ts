import path from "node:path";
import { readdir } from "node:fs/promises";
import { atomicWrite, readTextIfExists, withFileLock } from "../shared/fs.js";
import { taskStateSchema, type TaskState } from "./schemas.js";
import { appPaths, assertSafeId } from "../workspace/paths.js";

export class TaskStorage {
  constructor(private readonly root = appPaths().workspaceDir) {}

  workspacePath(workspaceId: string): string { return path.join(this.root, assertSafeId(workspaceId), "tasks"); }
  taskPath(workspaceId: string, taskId: string): string { return path.join(this.workspacePath(workspaceId), assertSafeId(taskId)); }
  statePath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "state.json"); }
  findingsPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "findings.md"); }
  specPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "spec.md"); }
  planPath(workspaceId: string, taskId: string): string { return path.join(this.taskPath(workspaceId, taskId), "plan.json"); }

  async list(workspaceId: string): Promise<TaskState[]> {
    let entries: string[];
    try { entries = await readdir(this.workspacePath(workspaceId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const states = await Promise.all(entries.sort().map(async (id) => {
      try { return await this.read(workspaceId, id); } catch { return undefined; }
    }));
    return states.filter((state): state is TaskState => state !== undefined)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async read(workspaceId: string, taskId: string): Promise<TaskState> {
    const raw = await readTextIfExists(this.statePath(workspaceId, taskId));
    if (raw === undefined) throw new Error(`Unknown memory: ${taskId}`);
    return taskStateSchema.parse(JSON.parse(raw));
  }

  async write(workspaceId: string, state: TaskState): Promise<void> {
    const parsed = taskStateSchema.parse(state);
    await atomicWrite(this.statePath(workspaceId, state.id), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async initialize(workspaceId: string, state: TaskState): Promise<void> {
    await this.write(workspaceId, state);
    await atomicWrite(this.findingsPath(workspaceId, state.id), `# Findings — ${state.title}\n\nUseful investigation knowledge only; no raw conversation or private reasoning.\n`);
    await atomicWrite(this.specPath(workspaceId, state.id), `# Specification — ${state.title}\n\nConfirmed design and implementation conclusions are recorded here.\n`);
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
    return await readTextIfExists(this.specPath(workspaceId, taskId)) || "";
  }

  async workspaceLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.workspacePath(workspaceId), ".tasks"), action);
  }
}
