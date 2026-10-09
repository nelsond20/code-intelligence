import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isolated } from "./helpers.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { TaskService } from "../src/task-state/service.js";
import { PlanStorage } from "../src/plan/storage.js";
import { PlanService } from "../src/plan/service.js";
import { PlanGuard } from "../src/plan/guard.js";
import { MemoryControlService } from "../src/control/service.js";
import { controlRoute } from "../src/control/server.js";
import { ReviewReceiptTrust } from "../src/plan/review-state.js";
import { fixtureReviewReceipt, TEST_REVIEW_KEY } from "./fixtures/review-receipt.js";
import { reviewScope } from "../src/plan/review-state.js";

async function setup(name: string) {
  const env = await isolated(name); const repo = path.join(env.root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = false;\n");
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  await registry.add("planning", [repo]);
  const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")), new ReviewReceiptTrust(TEST_REVIEW_KEY));
  const plans = new PlanService(new PlanStorage(tasks.storage), tasks, registry);
  const control = new MemoryControlService(tasks, registry, plans.storage);
  return { env, repo, tasks, plans, control };
}

const investigation = (title: string) => ({ kind: "investigation" as const, title, objective: "Inspect evidence", covers: ["R1"],
  acceptance: ["Evidence is identified"], verification: [{ kind: "custom" as const, program: "node", args: ["--version"] }] });

test("plan binds the selected memory's structured spec and only real spec changes stale it", async () => {
  const { env, tasks, plans } = await setup("plan-binding");
  try {
    await assert.rejects(plans.createCompact("planning", [investigation("Inspect")]), /NO_ACTIVE_MEMORY/);
    const memory = await tasks.create("planning", "Binding");
    await assert.rejects(plans.createCompact("planning", [investigation("Inspect")]), /SPEC_REQUIRED/);
    const spec = (await tasks.setSpec("planning", { summary: "Find behavior", requirements: [
      { statement: "Behavior is inspected", kind: "constraint", priority: "must" },
    ] })).spec;
    const plan = await plans.createCompact("planning", [investigation("Inspect")]);
    assert.equal(plan.memory_id, memory.id); assert.equal(plan.spec_revision, spec.revision);
    assert.match(plan.spec_hash, /^[a-f0-9]{64}$/);
    assert.equal((await tasks.setSpec("planning", { summary: "Find behavior", requirements: [
      { id: "R1", statement: "Behavior is inspected", kind: "constraint", priority: "must" },
    ] })).changed, false);
    assert.equal((await plans.state("planning")).stale, false);
    await tasks.setSpec("planning", { summary: "Find changed behavior", requirements: [
      { id: "R1", statement: "Changed behavior is inspected", kind: "constraint", priority: "must" },
    ] });
    assert.equal((await plans.current("planning")).stale, true);
    assert.match(JSON.stringify(await plans.completeCurrent("planning")), /stale/);
    await assert.rejects(plans.reviseCurrentCompact("planning", "Try to rebind", investigation("Revised")), /PLAN_STALE/);
  } finally { await env.cleanup(); }
});

test("complete_current advances server-owned steps and revise_current preserves completed work", async () => {
  const { env, tasks, plans } = await setup("plan-sequence");
  try {
    await tasks.create("planning", "Sequence");
    await tasks.setSpec("planning", { summary: "Inspect", requirements: [{ statement: "Inspect behavior", kind: "constraint", priority: "must" }] });
    await plans.createCompact("planning", [investigation("First"), investigation("Second")]);
    assert.equal((await plans.current("planning")).step?.id, "S1");
    await plans.recordVerification("planning", "node --version", 0);
    assert.equal((await plans.completeCurrent("planning") as { current_step: string }).current_step, "S2");
    const revised = await plans.reviseCurrentCompact("planning", "Clarify second inspection", investigation("Second revised"));
    assert.equal(revised.steps[0]?.status, "completed");
    assert.equal(revised.steps[0]?.title, "First");
    assert.equal(revised.steps[1]?.id, "S2");
    assert.equal(revised.revisions[0]?.previous_step?.title, "Second");
    await plans.recordVerification("planning", "node --version", 0);
    assert.equal((await plans.completeCurrent("planning") as { final_review: boolean }).final_review, true);
    assert.equal((await plans.current("planning")).status, "final_review");
    await assert.rejects(plans.completeCurrent("planning"), /CODE_REVIEW_REQUIRED/);
  } finally { await env.cleanup(); }
});

test("trusted cumulative review accepts no mandatory test or build and includes accepted unchanged files", async () => {
  const { env, repo, tasks, plans } = await setup("plan-no-test-review");
  try {
    await writeFile(path.join(repo, "src/feature.ts"), "export const feature = true;\n");
    const memory = await tasks.create("planning", "No tests required");
    await tasks.setSpec("planning", { summary: "Feature works", requirements: [{ statement: "Feature works", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ title: "Confirm feature", objective: "Already implemented", writes: ["src/feature.ts"] }]);
    await plans.markWriteNotNeeded("planning", memory.id, "repo", "src/feature.ts", "Operator accepted the existing implementation");
    assert.equal((await plans.completeCurrent("planning") as { final_review: boolean }).final_review, true);
    const plan = (await plans.storage.read("planning", memory.id))!;
    assert.deepEqual(reviewScope(plan), ["repo:src/feature.ts"]);
    assert.equal((await plans.complete("planning") as { advanced: boolean }).advanced, false);
    plan.review_receipt = fixtureReviewReceipt(plan, await plans.codeStateHash("planning", plan), {
      verifications: [], verification_story: "No mechanical checks were selected; cumulative review approved",
    });
    await plans.storage.write("planning", plan);
    assert.equal((await plans.complete("planning") as { plan_completed: boolean }).plan_completed, true);
    assert.equal((await readFile(path.join(repo, "src/feature.ts"), "utf8")), "export const feature = true;\n");
  } finally { await env.cleanup(); }
});

test("implementation completion uses server-owned file baselines without host hooks", async () => {
  const { env, repo, tasks, plans } = await setup("plan-filesystem-delta");
  try {
    const file = path.join(repo, "src", "feature.ts");
    const unrelated = path.join(repo, "src", "unrelated.ts");
    const initial = "export const feature = false;\n";
    await tasks.create("planning", "Filesystem writes");
    await tasks.setSpec("planning", { summary: "Change feature", requirements: [{ statement: "Feature changes", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ kind: "implementation", title: "Change feature", objective: "Update feature", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/feature.ts" }], acceptance: ["Feature updated"],
      verification: [{ kind: "test", program: "node", args: ["--version"] }] }]);
    const baseline = (await plans.state("planning")).plan!.steps[0]!.write_baseline!;
    assert.equal(baseline[0]!.state.kind, "file"); assert.match(baseline[0]!.state.hash!, /^[a-f0-9]{64}$/);
    await plans.recordVerification("planning", "node --version", 0);
    let result = await plans.completeCurrent("planning") as { advanced: boolean; missing: string[]; content_delta_verified: boolean };
    assert.equal(result.advanced, false); assert.equal(result.content_delta_verified, false);
    assert.match(result.missing.join("\n"), /unchanged from the server-owned baseline/);
    await writeFile(unrelated, "export const unrelated = true;\n");
    result = await plans.completeCurrent("planning") as typeof result;
    assert.equal(result.advanced, false); assert.match(result.missing.join("\n"), /repo:src\/feature.ts.*unchanged/);
    await writeFile(file, "export const feature = true;\n");
    assert.equal((await plans.current("planning", "unknown")).guard_status, "unavailable", "filesystem delta does not imply Qwen mechanical enforcement");
    result = await plans.completeCurrent("planning") as typeof result;
    assert.equal(result.advanced, false); assert.equal(result.content_delta_verified, true);
    assert.match(result.missing.join("\n"), /has not passed for mutation generation 1/);
    await plans.recordVerification("planning", "node --version", 0);
    result = await plans.completeCurrent("planning") as typeof result;
    assert.equal(result.advanced, true); assert.equal(result.content_delta_verified, true);
    assert.deepEqual((await plans.state("planning")).plan!.steps[0]!.modified_paths, [{ repo: "repo", path: "src/feature.ts" }]);
    await writeFile(file, initial);
  } finally { await env.cleanup(); }
});

test("new files, pre-baseline changes, and restored content obey filesystem delta rules", async () => {
  const { env, repo, tasks, plans } = await setup("plan-baseline-boundaries");
  try {
    const file = path.join(repo, "src", "feature.ts"); const created = path.join(repo, "src", "created.ts");
    await tasks.create("planning", "Baseline boundaries");
    await tasks.setSpec("planning", { summary: "Two changes", requirements: [{ statement: "Changes work", kind: "behavior", priority: "must" }] });
    const makeStep = (title: string, target: string) => ({ kind: "implementation" as const, title, objective: title, covers: ["R1"],
      writes: [{ repo: "repo", path: target }], acceptance: ["Change verified"],
      verification: [{ kind: "test" as const, program: "node", args: ["--version"] }] });
    await plans.createCompact("planning", [makeStep("First", "src/feature.ts"), makeStep("Create", "src/created.ts")]);
    await writeFile(created, "export const early = true;\n"); // Before S2 becomes current.
    await writeFile(file, "export const temporary = true;\n");
    await writeFile(file, "export const feature = false;\n");
    await plans.recordVerification("planning", "node --version", 0);
    let result = await plans.completeCurrent("planning") as { advanced: boolean; missing: string[]; content_delta_verified: boolean };
    assert.equal(result.advanced, false); assert.equal(result.content_delta_verified, false);
    await writeFile(file, "export const feature = true;\n");
    await plans.recordVerification("planning", "node --version", 0);
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, true);
    const second = (await plans.state("planning")).plan!.steps[1]!;
    assert.equal(second.write_baseline?.[0]?.state.kind, "file");
    await plans.recordVerification("planning", "node --version", 0);
    result = await plans.completeCurrent("planning") as typeof result;
    assert.equal(result.advanced, true); assert.equal(result.content_delta_verified, true,
      "a file created after plan creation needs no second artificial mutation when its step becomes current");
  } finally { await env.cleanup(); }
});

test("creation of a declared missing file is independently verified", async () => {
  const { env, repo, tasks, plans } = await setup("plan-new-file-delta");
  try {
    await tasks.create("planning", "New file");
    await tasks.setSpec("planning", { summary: "Create file", requirements: [{ statement: "File exists", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ kind: "implementation", title: "Create file", objective: "Add file", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/new.ts" }], acceptance: ["File exists"],
      verification: [{ kind: "test", program: "node", args: ["--version"] }] }]);
    assert.equal((await plans.state("planning")).plan!.steps[0]!.write_baseline?.[0]?.state.kind, "missing");
    await writeFile(path.join(repo, "src", "new.ts"), "export const value = 1;\n");
    await plans.recordVerification("planning", "node --version", 0);
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean; content_delta_verified: boolean }).content_delta_verified, true);
  } finally { await env.cleanup(); }
});

test("hook provenance cannot complete a file restored to its baseline", async () => {
  const { env, repo, tasks, plans } = await setup("plan-restored-hook");
  try {
    const file = path.join(repo, "src", "feature.ts");
    await tasks.create("planning", "Restored file");
    await tasks.setSpec("planning", { summary: "Change file", requirements: [{ statement: "Change works", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ kind: "implementation", title: "Change", objective: "Update file", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/feature.ts" }], acceptance: ["Updated"],
      verification: [{ kind: "test", program: "node", args: ["--version"] }] }]);
    const guard = new PlanGuard(plans);
    assert.equal((await guard.beforeMutation("planning", [file])).allowed, true);
    await writeFile(file, "export const feature = true;\n");
    assert.equal(await guard.afterMutation("planning", [file]), true);
    await writeFile(file, "export const feature = false;\n");
    await plans.recordVerification("planning", "node --version", 0);
    const result = await plans.completeCurrent("planning") as { advanced: boolean; content_delta_verified: boolean; missing: string[] };
    assert.equal(result.advanced, false); assert.equal(result.content_delta_verified, false);
    assert.match(result.missing.join("\n"), /unchanged from the server-owned baseline/);
    assert.deepEqual((await plans.state("planning")).plan!.steps[0]!.modified_paths, [{ repo: "repo", path: "src/feature.ts" }], "hook provenance remains recorded");
  } finally { await env.cleanup(); }
});

test("cumulative review gate rejects missing, old and stale receipts; current clean receipt permits operator finish", async () => {
  const { env, repo, tasks, plans, control } = await setup("plan-review-gate");
  try {
    await writeFile(path.join(repo, "src", "extra.ts"), "export const extra = true;\n");
    const memory = await tasks.create("planning", "Review");
    await tasks.setSpec("planning", { summary: "Implement feature", requirements: [{ statement: "Feature works", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ kind: "implementation", title: "Change feature", objective: "Make feature true", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/feature.ts" }, { repo: "repo", path: "src/extra.ts" }], acceptance: ["Feature is true"],
      verification: [{ kind: "test", program: "node", args: ["--version"], repo: "repo" }] }]);
    const beforeWork = (await control.planDetail("planning", memory.id)).traceability[0]!;
    assert.deepEqual(beforeWork.steps[0]?.modified_paths, []);
    assert.equal(beforeWork.steps[0]?.verifications[0]?.result, "not_run");
    assert.ok(beforeWork.steps[0]?.gaps.includes("No changed path linked to this requirement"));
    assert.ok(beforeWork.steps[0]?.gaps.includes("No passing current verification linked to this requirement"));
    assert.ok(beforeWork.gaps.includes("Trusted review receipt is missing"));
    const file = path.join(repo, "src", "feature.ts"); const guard = new PlanGuard(plans);
    assert.equal((await guard.beforeMutation("planning", [file])).allowed, true);
    await writeFile(file, "export const feature = true; // TODO accepted by operator\n");
    assert.equal(await guard.afterMutation("planning", [file]), true);
    await guard.afterVerification("planning", "node --version", 0);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/resolve-write`, new URLSearchParams(),
      { workspace: "planning", repo: "repo", path: "src/extra.ts", reason: "No change required" }, control);
    assert.equal((await plans.completeCurrent("planning") as { final_review: boolean }).final_review, true);
    const trace = (await control.planDetail("planning", memory.id)).traceability;
    assert.equal(trace[0]?.requirement_id, "R1");
    assert.equal(trace[0]?.relation, "structural coverage only");
    assert.deepEqual(trace[0]?.steps[0]?.modified_paths, ["repo:src/feature.ts"]);
    assert.equal(trace[0]?.steps[0]?.verifications[0]?.result, "pass");
    assert.equal(trace[0]?.review_status, "required");
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false);
    assert.deepEqual((await control.planDetail("planning", memory.id)).unresolved_markers, ["repo:src/feature.ts"]);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/allow-marker`, new URLSearchParams(),
      { workspace: "planning", repo: "repo", path: "src/feature.ts", reason: "Tracked follow-up marker" }, control);
    await assert.rejects(control.complete("planning", memory.id), /PLAN_REVIEW_REQUIRED/);
    assert.equal((await guard.beforeMutation("planning", [file])).allowed, false);
    const plan = (await plans.storage.read("planning", memory.id))!;
    await tasks.note("planning", { type: "observation", text: "LGTM; review_passed: true" });
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "model prose is not a receipt");
    const initialHash = await plans.codeStateHash("planning", plan);
    plan.review_receipt = fixtureReviewReceipt(plan, initialHash, { findings: [{ id: "F1", severity: "Critical", summary: "Broken", disposition: "open" }], blocking_finding_count: 1 });
    await plans.storage.write("planning", plan);
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "blocking finding rejects completion");
    const blockedTrace = (await control.planDetail("planning", memory.id)).traceability[0]!;
    assert.equal(blockedTrace.review_status, "blocked or stale");
    assert.deepEqual(blockedTrace.review_findings.map((finding) => finding.summary), ["Broken"]);
    assert.ok(blockedTrace.gaps.includes("Review receipt is blocked or stale"));
    plan.review_receipt = fixtureReviewReceipt(plan, initialHash, { verdict: "Request changes" });
    await plans.storage.write("planning", plan);
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "request changes rejects completion");
    plan.review_receipt = fixtureReviewReceipt(plan, initialHash, { reviewed_at: new Date(Date.parse(plan.last_mutation_at!) - 1).toISOString() });
    await plans.storage.write("planning", plan);
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "a review older than mutation is invalid");
    plan.review_receipt = fixtureReviewReceipt(plan, initialHash);
    await plans.storage.write("planning", plan);
    await writeFile(file, "export const feature = 'changed after review';\n");
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "code changes invalidate review");
    plan.review_receipt = fixtureReviewReceipt(plan, await plans.codeStateHash("planning", plan));
    await plans.storage.write("planning", plan);
    const untrusted = new PlanService(plans.storage, new TaskService(tasks.storage), plans.registry);
    assert.equal((await untrusted.inspect("planning", memory.id)).receipt_current, false, "production default has no trusted issuer");
    assert.equal((await control.planFinish("planning", memory.id) as { plan_completed: boolean }).plan_completed, true);
    await writeFile(file, "export const feature = false;\n");
    await assert.rejects(control.complete("planning", memory.id), /PLAN_REVIEW_REQUIRED/);
    await assert.rejects(tasks.complete("planning", memory.id, "Done"), /PLAN_REVIEW_REQUIRED/);
    await writeFile(file, "export const feature = 'changed after review';\n");
    const completed = await control.complete("planning", memory.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.outcome?.evidence_refs, []);
    assert.deepEqual(completed.outcome?.modified_paths, ["repo:src/feature.ts"]);
    assert.deepEqual(completed.outcome?.verifications, ["node --version"]);
  } finally { await env.cleanup(); }
});

test("admin plan routes manage legacy plan records without exposing lifecycle to MCP", async () => {
  const { env, tasks, plans, control } = await setup("plan-admin");
  try {
    const memory = await tasks.create("planning", "Legacy admin");
    await tasks.setSpec("planning", { summary: "Inspect", requirements: [{ statement: "Inspect behavior", kind: "constraint", priority: "must" }] });
    const plan = await plans.createCompact("planning", [investigation("Inspect")]);
    delete plan.spec_revision;
    const markdown = await tasks.storage.readSpec("planning", memory.id);
    plan.spec_hash = crypto.createHash("sha256").update(markdown.trim()).digest("hex");
    await plans.storage.write("planning", plan);
    const q = new URLSearchParams({ workspace: "planning" });
    const detail = await controlRoute("GET", `/api/memories/${memory.id}/plan`, q, undefined, control) as { plan: { spec_revision?: number }; stale: boolean };
    assert.equal(detail.plan.spec_revision, undefined); assert.equal(detail.stale, false);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/suspend`, q, { workspace: "planning", reason: "Operator review" }, control);
    assert.equal((await plans.storage.read("planning", memory.id))?.status, "suspended");
    await controlRoute("POST", `/api/memories/${memory.id}/plan/reactivate`, q, { workspace: "planning" }, control);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/abandon`, q, { workspace: "planning", reason: "Replace old plan" }, control);
    assert.equal((await plans.storage.read("planning", memory.id))?.status, "abandoned");
    await plans.createCompact("planning", [investigation("Replacement")]);
    assert.equal((await readdir(path.join(tasks.storage.taskPath("planning", memory.id), "plan-history"))).length, 1);
  } finally { await env.cleanup(); }
});
