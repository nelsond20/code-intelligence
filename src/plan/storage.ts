import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { TaskStorage } from "../task-state/storage.js";
import { planStateSchema, type PlanState } from "./schemas.js";

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
}
