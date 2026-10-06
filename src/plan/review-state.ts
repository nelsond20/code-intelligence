import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { PlanState } from "./schemas.js";

export async function cumulativeCodeHash(workspaceId: string, plan: PlanState, registry: WorkspaceRegistry): Promise<string> {
  const hash = crypto.createHash("sha256");
  for (const item of [...new Set(plan.steps.flatMap((step) => step.modified_paths.map((target) => `${target.repo}:${target.path}`)))].sort()) {
    const [repo, ...parts] = item.split(":"); const repository = await registry.resolveRepository(workspaceId, repo!);
    let content: string;
    try { content = crypto.createHash("sha256").update(await readFile(path.join(repository.path, parts.join(":")))).digest("hex"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; content = "<missing>"; }
    hash.update(item); hash.update("\0"); hash.update(content); hash.update("\0");
  }
  return hash.digest("hex");
}

export async function reviewReceiptCurrent(workspaceId: string, plan: PlanState, registry: WorkspaceRegistry): Promise<boolean> {
  const receipt = plan.review_receipt;
  if (!receipt) return false;
  const reviewed = Date.parse(receipt.reviewed_at);
  const enteredReview = Date.parse([...plan.lifecycle].reverse().find((item) => item.status === "final_review")?.at || plan.updated_at);
  if (!Number.isFinite(reviewed) || reviewed < enteredReview
    || plan.last_mutation_at && reviewed < Date.parse(plan.last_mutation_at)) return false;
  try { return receipt.code_hash === await cumulativeCodeHash(workspaceId, plan, registry); }
  catch { return false; }
}
