import crypto from "node:crypto";
import type { TaskStorage } from "../task-state/storage.js";
import type { StructuredSpec } from "../task-state/schemas.js";
import type { PlanState } from "./schemas.js";

export function structuredSpecHash(spec: StructuredSpec): string {
  return crypto.createHash("sha256").update(JSON.stringify({ revision: spec.revision, summary: spec.summary, requirements: spec.requirements })).digest("hex");
}

export async function planBindingStale(storage: TaskStorage, workspaceId: string, plan: PlanState): Promise<boolean> {
  if (plan.spec_revision) {
    const spec = await storage.readStructuredSpec(workspaceId, plan.memory_id);
    return !spec || spec.revision !== plan.spec_revision || structuredSpecHash(spec) !== plan.spec_hash;
  }
  const markdown = await storage.readSpec(workspaceId, plan.memory_id);
  return crypto.createHash("sha256").update(markdown.trim()).digest("hex") !== plan.spec_hash;
}
