import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { walkReadableFiles } from "../search/files.js";
import { reviewReceiptSchema, type PlanState } from "./schemas.js";

/** No production issuer is configured. A trusted runtime must supply its own secret. */
export class ReviewReceiptTrust {
  constructor(private readonly verificationKey: string) {}

  verify(receipt: unknown): boolean {
    const parsed = reviewReceiptSchema.safeParse(receipt);
    if (!parsed.success) return false;
    const { signature, ...payload } = parsed.data;
    const expected = crypto.createHmac("sha256", this.verificationKey).update(JSON.stringify(payload)).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  }
}

export function reviewScope(plan: PlanState): string[] {
  return [...new Set(plan.steps.flatMap((step) => [
    ...step.modified_paths.map((target) => `${target.repo}:${target.path}`),
    ...step.writes.filter((write) => !!write.not_needed_reason).map((write) => `${write.repo}:${write.path}`),
  ]))].sort();
}

export async function cumulativeCodeHash(workspaceId: string, _plan: PlanState, registry: WorkspaceRegistry): Promise<string> {
  const hash = crypto.createHash("sha256");
  const workspace = await registry.get(workspaceId);
  for (const repository of [...workspace.repositories].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const relative of await walkReadableFiles(repository.path)) {
      let content: string;
      try { content = crypto.createHash("sha256").update(await readFile(path.join(repository.path, relative))).digest("hex"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; content = "<missing>"; }
      hash.update(repository.id); hash.update("\0"); hash.update(relative); hash.update("\0"); hash.update(content); hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function blockingFindingCount(findings: Array<{ severity: string; disposition: string; reason?: string }>): number {
  return findings.filter((item) => item.severity === "Critical" ? item.disposition !== "resolved"
    : item.severity === "Required" && (item.disposition === "open" || item.disposition === "handled" && !item.reason?.trim())).length;
}

export async function reviewReceiptCurrent(workspaceId: string, plan: PlanState, registry: WorkspaceRegistry,
  trust?: ReviewReceiptTrust): Promise<boolean> {
  const receipt = plan.review_receipt;
  if (!receipt || !trust || !trust.verify(receipt)) return false;
  const parsed = reviewReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const value = parsed.data;
  const reviewed = Date.parse(value.reviewed_at);
  const enteredReview = Date.parse([...plan.lifecycle].reverse().find((item) => item.status === "final_review")?.at || plan.updated_at);
  if (!Number.isFinite(reviewed) || reviewed < enteredReview
    || plan.last_mutation_at && reviewed < Date.parse(plan.last_mutation_at)) return false;
  if (value.memory_id !== plan.memory_id || value.plan_revision !== plan.revision || value.spec_hash !== plan.spec_hash
    || value.spec_revision !== plan.spec_revision || JSON.stringify(value.reviewed_scope) !== JSON.stringify(reviewScope(plan))) return false;
  const blocking = blockingFindingCount(value.findings);
  if (value.blocking_finding_count !== blocking || blocking > 0 || value.verdict !== "Approve") return false;
  if (value.verifications.some((item) => item.result === "fail")) return false;
  try { return value.code_hash === await cumulativeCodeHash(workspaceId, plan, registry); }
  catch { return false; }
}
