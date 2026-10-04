import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { defaultConfig } from "../src/config/schema.js";
import { PlanGuard } from "../src/plan/guard.js";
import { PlanService } from "../src/plan/service.js";
import { PlanStorage } from "../src/plan/storage.js";
import { RepositoryAccessPolicy } from "../src/privacy/repository-access.js";
import { SemanticIndex } from "../src/search/semantic.js";
import { TaskService } from "../src/task-state/service.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { formatToolResponse } from "../src/mcp/server.js";
import { isolated } from "./helpers.js";

async function guardedFixture(name: string) {
  const env = await isolated(name); const repo = path.join(env.root, "repo"); await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "allowed.ts"), "export const allowed = 1;\n");
  await writeFile(path.join(repo, "src", "outside.ts"), "export const outside = 1;\n");
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces")); await registry.add("planning", [repo]);
  const storage = new TaskStorage(path.join(env.data, "workspaces")); const tasks = new TaskService(storage);
  const plans = new PlanService(new PlanStorage(storage), tasks, registry); await tasks.create("planning", "Guard invariants");
  await tasks.replaceSpec("planning", undefined, { summary: "Implement safely", requirements: [{ statement: "Allowed behavior changes", kind: "behavior", priority: "must" }] });
  const step = { kind: "implementation" as const, title: "Change allowed", objective: "Change one file", covers: ["R1"],
    writes: [{ repo: "repo", path: "src/allowed.ts", covers: ["R1"] }], context: [],
    acceptance: [{ statement: "Behavior is tested", covers: ["R1"] }],
    verification: [{ kind: "test" as const, program: "npm", args: ["test"], repo: "repo", expect_exit: 0 }] };
  return { env, repo, tasks, plans, registry, step };
}

test("repository policy reapplies nested security ignores and negations on exact reads", async () => {
  const env = await isolated("policy-live");
  try {
    const repo = path.join(env.root, "repo"); await mkdir(path.join(repo, "src", "private"), { recursive: true });
    await writeFile(path.join(repo, ".codeintelligenceignore"), "src/private/**\n!src/private/public.ts\n");
    await writeFile(path.join(repo, "src", "private", "secret.ts"), "secret\n");
    await writeFile(path.join(repo, "src", "private", "public.ts"), "public\n");
    const policy = await RepositoryAccessPolicy.create(repo);
    assert.equal(policy.canRead("src/private/secret.ts"), false); assert.equal(policy.canRead("src/private/public.ts"), true);
    await assert.rejects(policy.resolveFile("src/private/secret.ts"), /excluded/);
    assert.equal((await policy.resolveFile("src/private/public.ts")).relative, "src/private/public.ts");
  } finally { await env.cleanup(); }
});

test("plan lifecycle, no-op mutation, mutating verification, and shell postconditions are enforced", async () => {
  const setup = await guardedFixture("guard-postconditions");
  try {
    await assert.rejects(setup.plans.create("planning", [{ ...setup.step, verification: [{ command: "node -e writeFile('x','y')" }] }]), /mutating/);
    await setup.plans.create("planning", [setup.step]);
    await assert.rejects(setup.plans.create("planning", [setup.step]), /already has/);
    await assert.rejects(setup.tasks.transition("planning", "paused"), /active plan/);
    const guard = new PlanGuard(setup.plans, setup.registry); const allowed = path.join(setup.repo, "src", "allowed.ts");
    assert.equal((await guard.beforeMutation("planning", [allowed])).allowed, true);
    assert.equal(await guard.afterMutation("planning", [allowed]), false, "no-op editor calls cannot count as mutations");
    await guard.afterVerification("planning", "npm test", 0);
    assert.match(((await setup.plans.complete("planning")) as { missing: string[] }).missing.join("\n"), /no observed content mutation/);
    assert.equal((await guard.beforeShell("planning", "npm test")).allowed, true);
    await writeFile(path.join(setup.repo, "src", "outside.ts"), "export const outside = 2;\n");
    const shell = await guard.afterShell("planning", "npm test", 0);
    assert.deepEqual(shell.violations, ["repo:src/outside.ts"]); assert.equal(shell.verified, false);
    assert.match(((await setup.plans.complete("planning")) as { missing: string[] }).missing.join("\n"), /guard violation/);
    await setup.plans.transition("planning", "suspended", "switch tasks");
    assert.equal((await guard.beforeMutation("planning", [allowed])).allowed, false);
    await setup.tasks.transition("planning", "paused");
  } finally { await setup.env.cleanup(); }
});

test("structured specification requires complete plan coverage", async () => {
  const setup = await guardedFixture("coverage-ledger");
  try {
    await setup.tasks.patchSpec("planning", undefined, "Add edge case", [{ op: "add", requirement: { statement: "Reject negative values", kind: "behavior", priority: "must" } }]);
    await assert.rejects(setup.plans.create("planning", [setup.step]), /R2/);
    const covered = { ...setup.step, covers: ["R1", "R2"], writes: [{ ...setup.step.writes[0]!, covers: ["R1", "R2"] }],
      acceptance: [{ statement: "Both behaviors are tested", covers: ["R1", "R2"] }] };
    assert.equal((await setup.plans.create("planning", [covered])).steps[0]?.id, "S1");
  } finally { await setup.env.cleanup(); }
});

test("memory records require inspected evidence and completed memory remains searchable", async () => {
  const env = await isolated("memory-evidence");
  try {
    const storage = new TaskStorage(path.join(env.data, "workspaces")); const tasks = new TaskService(storage);
    const memory = await tasks.create("planning", "Evidence memory", { objective: "Keep traceable facts" });
    await assert.rejects(tasks.note("planning", { type: "evidence", text: "Confirmed fact", evidence_refs: ["code://repo/file#L=1-1"] }), /not been inspected/);
    await tasks.recordInspection("planning", { ref: "code://repo/file#L=1-1", repo: "repo", files: ["file"] });
    const noted = await tasks.note("planning", { type: "evidence", text: "Confirmed fact", evidence_refs: ["code://repo/file#L=1-1"] });
    await tasks.resolve("planning", noted.records[0]!.id, "confirmed", "Source inspection", ["code://repo/file#L=1-1"]);
    await tasks.complete("planning", undefined, "Evidence workflow completed");
    assert.equal((await tasks.read("planning", memory.id)).records[0]?.status, "confirmed");
    assert.equal((await tasks.search("planning", "confirmed fact"))[0]?.memory_id, memory.id);
  } finally { await env.cleanup(); }
});

test("semantic indexes are isolated by workspace/root and stale source is not materialized", async () => {
  const env = await isolated("semantic-isolation");
  try {
    const firstRoot = path.join(env.root, "first"); const secondRoot = path.join(env.root, "second"); await mkdir(firstRoot); await mkdir(secondRoot);
    await writeFile(path.join(firstRoot, "same.ts"), "export const alpha = 'first';\n");
    await writeFile(path.join(secondRoot, "same.ts"), "export const beta = 'second';\n");
    const config = defaultConfig(); config.embeddings.enabled = true; const embed = async (texts: string[]) => texts.map((text) => [text.includes("first") ? 1 : 0, text.includes("second") ? 1 : 0]);
    const first = new SemanticIndex(config, path.join(env.data, "indexes"), fetch, "workspace-a");
    const second = new SemanticIndex(config, path.join(env.data, "indexes"), fetch, "workspace-b");
    const firstRepo = { id: "same", path: firstRoot }; const secondRepo = { id: "same", path: secondRoot };
    await first.index(firstRepo, false, embed); await second.index(secondRepo, false, embed);
    assert.match((await first.search([firstRepo], "first", 3, embed))[0]!.snippet, /first/);
    assert.match((await second.search([secondRepo], "second", 3, embed))[0]!.snippet, /second/);
    await writeFile(path.join(firstRoot, "same.ts"), "export const changed = true;\n");
    assert.equal(await first.status(firstRepo), "stale"); assert.equal((await first.search([firstRepo], "first", 3, embed)).length, 0);
  } finally { await env.cleanup(); }
});

test("oversized MCP responses remain valid structured JSON", () => {
  const response = formatToolResponse({ rows: Array.from({ length: 100 }, (_, index) => ({ index, text: "x".repeat(10_000) })) });
  const text = response.content[0]!.text;
  assert.ok(Buffer.byteLength(text) <= 24_000);
  const parsed = JSON.parse(text) as { status: string; truncated: boolean; data?: { rows?: unknown[] } };
  assert.ok(["ok", "degraded"].includes(parsed.status));
  assert.equal(parsed.truncated, true);
  const planLike = JSON.parse(formatToolResponse({ status: "active", step: { id: "S1" } }).content[0]!.text) as { status: string; data: { status: string } };
  assert.equal(planLike.status, "ok"); assert.equal(planLike.data.status, "active");
});

test("task file transactions roll back related writes on failure", async () => {
  const env = await isolated("task-transaction");
  try {
    const storage = new TaskStorage(path.join(env.data, "workspaces")); const tasks = new TaskService(storage);
    const memory = await tasks.create("planning", "Transactional memory");
    const before = await readFile(storage.findingsPath("planning", memory.id), "utf8");
    await assert.rejects(storage.transaction("planning", memory.id, "simulated-failure", async () => {
      await writeFile(storage.findingsPath("planning", memory.id), "partial write\n");
      throw new Error("simulated crash");
    }), /simulated crash/);
    assert.equal(await readFile(storage.findingsPath("planning", memory.id), "utf8"), before);
    const journal = JSON.parse(await readFile(storage.transactionPath("planning", memory.id), "utf8")) as { status: string };
    assert.equal(journal.status, "recovered");
  } finally { await env.cleanup(); }
});

test("specification rollback creates a new immutable revision", async () => {
  const env = await isolated("spec-rollback");
  try {
    const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
    const memory = await tasks.create("planning", "Versioned specification");
    await tasks.replaceSpec("planning", memory.id, { summary: "First", requirements: [{ statement: "Keep first behavior", kind: "behavior", priority: "must" }] });
    await tasks.patchSpec("planning", memory.id, "Add second requirement", [{ op: "add", requirement: { statement: "Keep second behavior", kind: "behavior", priority: "must" } }]);
    const restored = await tasks.rollbackSpec("planning", memory.id, 1, "Second requirement was premature");
    assert.equal(restored.revision, 3); assert.deepEqual(restored.requirements.map((item) => item.id), ["R1"]);
    assert.match(restored.reason || "", /Rollback to revision 1/);
    assert.equal((await tasks.storage.readSpecRevision("planning", memory.id, 2)).requirements.length, 2);
  } finally { await env.cleanup(); }
});
