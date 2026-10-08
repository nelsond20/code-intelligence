import crypto from "node:crypto";
import { reviewReceiptSchema, type PlanState } from "../../src/plan/schemas.js";
import { reviewScope } from "../../src/plan/review-state.js";

export const TEST_REVIEW_KEY = "deterministic-repository-fixture-key";

/** Test-only issuer. No runtime path calls this fixture. */
export function fixtureReviewReceipt(plan: PlanState, codeHash: string, overrides: Record<string, unknown> = {}) {
  const payload = { schema_version: 1 as const, reviewer: "code-review-and-quality" as const,
    memory_id: plan.memory_id, plan_revision: plan.revision, spec_hash: plan.spec_hash, spec_revision: plan.spec_revision,
    code_hash: codeHash, reviewed_scope: reviewScope(plan), reviewed_at: new Date(Date.now() + 1000).toISOString(),
    findings: [], blocking_finding_count: 0, verdict: "Approve" as const,
    verifications: [{ kind: "test" as const, command: "node --version", result: "pass" as const },
      { kind: "build" as const, command: "npm run build", result: "pass" as const }],
    verification_story: "Fixture records deterministic test and build results", ...overrides };
  const signature = crypto.createHmac("sha256", TEST_REVIEW_KEY).update(JSON.stringify(payload)).digest("hex");
  return reviewReceiptSchema.parse({ ...payload, signature });
}
