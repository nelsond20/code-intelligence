import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { TaskStorage } from "../task-state/storage.js";
import { planStateSchema, type PlanState } from "./schemas.js";

export class PlanStorage {
  constructor(readonly tasks = new TaskStorage()) {}

  path(workspaceId: string, memoryId: string): string { return this.tasks.planPath(workspaceId, memoryId); }

  async read(workspaceId: string, memoryId: string): Promise<PlanState | undefined> {
    const raw = await readTextIfExists(this.path(workspaceId, memoryId));
    return raw === undefined ? undefined : planStateSchema.parse(JSON.parse(raw));
  }

  async write(workspaceId: string, plan: PlanState): Promise<void> {
    const parsed = planStateSchema.parse(plan);
    await atomicWrite(this.path(workspaceId, plan.memory_id), `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

