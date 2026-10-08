import { atomicWrite, purgeDirectory, readTextIfExists } from "../shared/fs.js";
import { TaskStorage } from "../task-state/storage.js";
import { planStateSchema, type PlanState } from "./schemas.js";
import path from "node:path";
import crypto from "node:crypto";
import { readdir, rm } from "node:fs/promises";

export class PlanStorage {
  constructor(readonly tasks = new TaskStorage()) {}

  path(workspaceId: string, memoryId: string): string { return this.tasks.planPath(workspaceId, memoryId); }

  async read(workspaceId: string, memoryId: string): Promise<PlanState | undefined> {
    const raw = await this.tasks.readPlan(workspaceId, memoryId);
    return raw === undefined ? undefined : planStateSchema.parse(JSON.parse(raw));
  }

  async write(workspaceId: string, plan: PlanState): Promise<void> {
    const parsed = planStateSchema.parse(plan);
    await this.tasks.transaction(workspaceId, plan.memory_id, "write-plan", async () => {
      const target = this.path(workspaceId, plan.memory_id); const previous = await readTextIfExists(target);
      if (previous !== undefined) await atomicWrite(`${target}.backup`, previous);
      await atomicWrite(target, `${JSON.stringify(parsed, null, 2)}\n`);
    });
  }

  async archiveTerminal(workspaceId: string, plan: PlanState): Promise<void> {
    if (plan.status !== "completed" && plan.status !== "abandoned" && !plan.archived_at) throw new Error("Only terminal or explicitly archived plans can be saved to history");
    const parsed = planStateSchema.parse(plan);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 16);
    const file = path.join(this.tasks.taskPath(workspaceId, plan.memory_id), "plan-history", `${fingerprint}.json`);
    await atomicWrite(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async historyEntries(workspaceId: string, memoryId: string): Promise<Array<{ id: string; plan: PlanState }>> {
    const directory = path.join(this.tasks.taskPath(workspaceId, memoryId), "plan-history");
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(files.filter((file) => /^[a-f0-9]{16}\.json$/.test(file)).sort().map(async (file) => {
      const raw = await readTextIfExists(path.join(directory, file));
      return { id: file.slice(0, -5), plan: planStateSchema.parse(JSON.parse(raw!)) };
    }));
  }

  async history(workspaceId: string, memoryId: string): Promise<PlanState[]> {
    return (await this.historyEntries(workspaceId, memoryId)).map((item) => item.plan);
  }

  async delete(workspaceId: string, memoryId: string): Promise<void> {
    await purgeDirectory(path.join(this.tasks.taskPath(workspaceId, memoryId), "plan-history"));
    await rm(this.path(workspaceId, memoryId), { force: true });
    await rm(`${this.path(workspaceId, memoryId)}.backup`, { force: true });
  }
}
