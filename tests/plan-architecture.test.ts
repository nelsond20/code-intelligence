import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isolated } from "./helpers.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { TaskService } from "../src/task-state/service.js";
import { PlanStorage } from "../src/plan/storage.js";
import { PlanService } from "../src/plan/service.js";
import { PlanGuard } from "../src/plan/guard.js";
import { MemoryControlService } from "../src/control/service.js";
import { controlRoute } from "../src/control/server.js";

async function setup(name: string) {
  const env = await isolated(name); const repo = path.join(env.root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = false;\n");
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  await registry.add("planning", [repo]);
  const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
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

test("cumulative review gate rejects missing, old and stale receipts; current clean receipt permits operator finish", async () => {
  const { env, repo, tasks, plans, control } = await setup("plan-review-gate");
  try {
    await writeFile(path.join(repo, "src", "extra.ts"), "export const extra = true;\n");
    const memory = await tasks.create("planning", "Review");
    await tasks.setSpec("planning", { summary: "Implement feature", requirements: [{ statement: "Feature works", kind: "behavior", priority: "must" }] });
    await plans.createCompact("planning", [{ kind: "implementation", title: "Change feature", objective: "Make feature true", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/feature.ts" }, { repo: "repo", path: "src/extra.ts" }], acceptance: ["Feature is true"],
      verification: [{ kind: "test", program: "node", args: ["--version"], repo: "repo" }] }]);
    const file = path.join(repo, "src", "feature.ts"); const guard = new PlanGuard(plans);
    assert.equal((await guard.beforeMutation("planning", [file])).allowed, true);
    await writeFile(file, "export const feature = true; // TODO accepted by operator\n");
    assert.equal(await guard.afterMutation("planning", [file]), true);
    await guard.afterVerification("planning", "node --version", 0);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/resolve-write`, new URLSearchParams(),
      { workspace: "planning", repo: "repo", path: "src/extra.ts", reason: "No change required" }, control);
    assert.equal((await plans.completeCurrent("planning") as { final_review: boolean }).final_review, true);
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false);
    assert.deepEqual((await control.planDetail("planning", memory.id)).unresolved_markers, ["repo:src/feature.ts"]);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/allow-marker`, new URLSearchParams(),
      { workspace: "planning", repo: "repo", path: "src/feature.ts", reason: "Tracked follow-up marker" }, control);
    await assert.rejects(control.complete("planning", memory.id), /PLAN_REVIEW_REQUIRED/);
    assert.equal((await guard.beforeMutation("planning", [file])).allowed, false);
    const plan = (await plans.storage.read("planning", memory.id))!;
    const receipt = { skill: "code-review-and-quality" as const, code_hash: await plans.codeStateHash("planning", plan),
      reviewed_at: new Date(Date.parse(plan.last_mutation_at!) - 1).toISOString(), status: "completed" as const, blocking_findings: false as const };
    plan.review_receipt = receipt; await plans.storage.write("planning", plan);
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "a review older than mutation is invalid");
    plan.review_receipt = { ...receipt, reviewed_at: new Date(Date.now() + 1000).toISOString() };
    await plans.storage.write("planning", plan);
    await writeFile(file, "export const feature = 'changed after review';\n");
    assert.equal((await control.planFinish("planning", memory.id) as { advanced: boolean }).advanced, false, "code changes invalidate review");
    plan.review_receipt = { ...plan.review_receipt, code_hash: await plans.codeStateHash("planning", plan) };
    await plans.storage.write("planning", plan);
    assert.equal((await control.planFinish("planning", memory.id) as { plan_completed: boolean }).plan_completed, true);
    await writeFile(file, "export const feature = false;\n");
    await assert.rejects(control.complete("planning", memory.id), /PLAN_REVIEW_REQUIRED/);
    await assert.rejects(tasks.complete("planning", memory.id, "Done"), /PLAN_REVIEW_REQUIRED/);
    await writeFile(file, "export const feature = 'changed after review';\n");
    assert.equal((await control.complete("planning", memory.id)).status, "completed");
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
