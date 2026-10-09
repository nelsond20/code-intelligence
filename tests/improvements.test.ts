import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { pageMemoryCurrent } from "../src/mcp/memory-page.js";
import { pagePlanCurrent } from "../src/mcp/plan-page.js";
import { taskStateSchema } from "../src/task-state/schemas.js";
import { walkReadableFiles } from "../src/search/files.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolated, projectRoot } from "./helpers.js";

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
    assert.match(((await setup.plans.complete("planning")) as { missing: string[] }).missing.join("\n"), /no filesystem content delta/);
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

test("pre-plan spec denies direct and indirect shell writes before execution", async () => {
  const setup = await guardedFixture("preplan-indirect");
  try {
    const guard = new PlanGuard(setup.plans, setup.registry);
    const script = path.join(setup.repo, "package.json");
    const target = path.join(setup.repo, "src", "indirect.ts");
    await writeFile(script, JSON.stringify({ scripts: { report: "node -e \"require('fs').writeFileSync('src/indirect.ts','changed')\"" } }));
    await promisify(execFile)("npm", ["run", "report"], { cwd: setup.repo });
    assert.equal(await readFile(target, "utf8"), "changed", "the innocuous script really writes");
    await (await import("node:fs/promises")).rm(target);
    assert.match((await guard.beforeShell("planning", "npm run report")).reason || "", /^PLAN_REQUIRED:/);
    assert.match((await guard.beforeShell("planning", "echo changed > src/allowed.ts")).reason || "", /^PLAN_REQUIRED:/);
    await assert.rejects(readFile(target), /ENOENT/);
    await setup.plans.create("planning", [setup.step]);
    assert.equal((await guard.beforeShell("planning", "npm test")).allowed, true);
    await guard.afterShell("planning", "npm test", 0);
    await setup.tasks.patchSpec("planning", undefined, "Stale plan", [{ op: "add", requirement: { statement: "Extra", kind: "constraint", priority: "must" } }]);
    assert.equal((await guard.beforeShell("planning", "npm test")).allowed, false);
  } finally { await setup.env.cleanup(); }
});

test("shell guard hashes only allowed and changed candidates while detecting all path operations", async (t) => {
  const setup = await guardedFixture("guard-work-counts");
  try {
    for (let index = 0; index < 80; index++) await writeFile(path.join(setup.repo, "src", `extra-${index}.ts`), `export const n = ${index};\n`);
    await setup.plans.create("planning", [setup.step]);
    const before = await setup.plans.captureShell("planning");
    const unchanged = await setup.plans.recordShell("planning", "npm test", 0);
    assert.equal(before.scans, 1); assert.ok(before.stats >= 82);
    assert.equal(before.hashes, 1); assert.equal(unchanged.work?.hashes, 0);
    assert.equal(unchanged.changed.length, 0); assert.equal(unchanged.verified, true);
    const allowedPath = path.join(setup.repo, "src", "allowed.ts");
    const originalStat = await (await import("node:fs/promises")).stat(allowedPath);
    await setup.plans.captureShell("planning");
    await writeFile(allowedPath, "export const allowed = 2;\n");
    await (await import("node:fs/promises")).utimes(allowedPath, originalStat.atime, originalStat.mtime);
    const restoredMtime = await setup.plans.recordShell("planning", "npm test", 0);
    assert.deepEqual(restoredMtime.changed, ["repo:src/allowed.ts"], "ctime and hash detect a same-size write with restored mtime");
    const oldSnapshotBytes = Buffer.byteLength(JSON.stringify((await walkReadableFiles(setup.repo)).map((relative) =>
      ({ repo: "repo", path: relative, hash: "a".repeat(64) }))));
    t.diagnostic(JSON.stringify({ baseline: { scans: 2, files_hashed: before.stats * 2, snapshot_bytes: oldSnapshotBytes },
      optimized: { scans: before.scans + (unchanged.work?.scans || 0), files_stated: before.stats + (unchanged.work?.stats || 0),
        files_hashed: before.hashes + (unchanged.work?.hashes || 0), snapshot_bytes: before.snapshot_bytes } }));
    assert.ok(before.snapshot_bytes < oldSnapshotBytes);
    await setup.plans.captureShell("planning");
    await writeFile(path.join(setup.repo, "src", "allowed.ts"), "export const allowed = 3;\n");
    const allowed = await setup.plans.recordShell("planning", "npm test", 0);
    assert.deepEqual(allowed.changed, ["repo:src/allowed.ts"]); assert.deepEqual(allowed.violations, []);
    await setup.plans.captureShell("planning");
    await writeFile(path.join(setup.repo, "src", "outside.ts"), "export const outside = 3;\n");
    await writeFile(path.join(setup.repo, "src", "new.ts"), "new\n");
    const forbidden = await setup.plans.recordShell("planning", "npm test", 0);
    assert.deepEqual(new Set(forbidden.violations), new Set(["repo:src/outside.ts", "repo:src/new.ts"]));
    await setup.plans.captureShell("planning");
    await (await import("node:fs/promises")).rename(path.join(setup.repo, "src", "new.ts"), path.join(setup.repo, "src", "renamed.ts"));
    await (await import("node:fs/promises")).rm(path.join(setup.repo, "src", "outside.ts"));
    const removed = await setup.plans.recordShell("planning", "npm test", 0);
    assert.deepEqual(new Set(removed.violations), new Set(["repo:src/new.ts", "repo:src/renamed.ts", "repo:src/outside.ts"]));
  } finally { await setup.env.cleanup(); }
});

test("structured specification does not require duplicated plan coverage or tests", async () => {
  const setup = await guardedFixture("coverage-ledger");
  try {
    await setup.tasks.patchSpec("planning", undefined, "Add edge case", [{ op: "add", requirement: { statement: "Reject negative values", kind: "behavior", priority: "must" } }]);
    const created = await setup.plans.create("planning", [setup.step]);
    assert.equal(created.steps[0]?.id, "S1");
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

test("current confirmed projection follows record status and keeps history", async () => {
  const env = await isolated("memory-current-projection");
  try {
    const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
    const memory = await tasks.create("planning", "Projection"); const ref = "code://repo/file#L=1-1";
    await tasks.recordInspection("planning", { ref });
    const noted = await tasks.note("planning", { type: "evidence", text: "A fact now revoked", evidence_refs: [ref] });
    assert.deepEqual((await tasks.current("planning"))?.supported_findings, ["A fact now revoked"]);
    assert.match(await tasks.context("planning"), /Supported: A fact now revoked/);
    assert.doesNotMatch(await tasks.context("planning"), /Confirmed: A fact now revoked/);
    await tasks.resolve("planning", noted.records[0]!.id, "confirmed", "Confirmed by inspection", [ref]);
    assert.deepEqual((await tasks.current("planning"))?.confirmed_findings, ["A fact now revoked"]);
    await tasks.resolve("planning", noted.records[0]!.id, "rejected", "Evidence contradicted", [ref]);
    assert.deepEqual((await tasks.current("planning"))?.confirmed_findings, []);
    assert.deepEqual((await tasks.current("planning"))?.supported_findings, []);
    assert.doesNotMatch(await tasks.context("planning"), /Confirmed: A fact now revoked/);
    assert.equal((await tasks.read("planning", memory.id)).records[0]?.status, "rejected");
    const second = await tasks.note("planning", { type: "evidence", text: "Archived evidence", evidence_refs: [ref] });
    const archived = await tasks.storage.read("planning", memory.id);
    archived.records.find((item) => item.id === second.records[0]!.id)!.archived_at = new Date().toISOString();
    await tasks.storage.write("planning", archived);
    assert.deepEqual((await tasks.current("planning"))?.supported_findings, []);
    assert.equal((await tasks.read("planning", memory.id)).records.length, 2);
    const raw = JSON.parse(await readFile(tasks.storage.statePath("planning", memory.id), "utf8")) as { confirmed_findings: string[]; supported_findings: string[] };
    assert.deepEqual(raw.confirmed_findings, [], "no duplicated persisted truth");
    assert.deepEqual(raw.supported_findings, []);
  } finally { await env.cleanup(); }
});

test("semantic identity rejects model, provider and dimension mismatch and detects added files", async () => {
  const env = await isolated("semantic-identity");
  try {
    const root = path.join(env.root, "repo"); await mkdir(root); await writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    const repo = { id: "repo", path: root }; const config = defaultConfig(); config.embeddings.enabled = true;
    const indexRoot = path.join(env.data, "index"); const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const index = new SemanticIndex(config, indexRoot); await index.index(repo, false, embed);
    assert.equal(await index.status(repo), "fresh"); assert.equal((await index.search([repo], "one", 2, embed)).length, 1);
    const model = structuredClone(config); model.embeddings.model = "different";
    const provider = structuredClone(config); provider.embeddings.provider = provider.embeddings.provider === "ollama" ? "llamacpp" : "ollama";
    for (const altered of [model, provider]) {
      const candidate = new SemanticIndex(altered, indexRoot);
      assert.equal(await candidate.status(repo), "stale");
      await assert.rejects(candidate.search([repo], "one", 2, embed), /incompatible.*rebuild/);
    }
    await assert.rejects(index.search([repo], "one", 2, async () => [[1, 0, 0]]), /dimension.*rebuild/);
    const [fingerprint] = await readdir(path.join(indexRoot, "default", repo.id));
    const manifest = JSON.parse(await readFile(path.join(indexRoot, "default", repo.id, fingerprint!, "current.json"), "utf8")) as { generation: string };
    const vectorPath = path.join(indexRoot, "default", repo.id, fingerprint!, "generations", manifest.generation, "semantic-vectors.bin");
    const original = JSON.parse(await readFile(vectorPath, "utf8")) as { provider?: string; dimensions: number; vectors: number[][] };
    const withoutProvider = { ...original, provider: undefined };
    await writeFile(vectorPath, JSON.stringify(withoutProvider));
    assert.equal(await index.status(repo), "stale");
    await assert.rejects(index.search([repo], "one", 2, embed), /incompatible.*rebuild/);
    await writeFile(vectorPath, JSON.stringify({ ...original, dimensions: 3 }));
    assert.equal(await index.status(repo), "stale");
    await assert.rejects(index.search([repo], "one", 2, embed), /incompatible.*rebuild/);
    await writeFile(vectorPath, JSON.stringify({ ...original, vectors: [[1, 0, 0]] }));
    assert.equal(await index.status(repo), "stale");
    await assert.rejects(index.search([repo], "one", 2, embed), /inconsistent/);
    await writeFile(vectorPath, JSON.stringify(original));
    await writeFile(path.join(root, "two.ts"), "export const two = 2;\n");
    assert.equal(await index.status(repo), "partial");
  } finally { await env.cleanup(); }
});

test("large memory.current pages preserve and retrieve all IDs deterministically", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const memory = taskStateSchema.parse({ schema_version: 2, id: "internal", title: "Large", status: "active", phase: "specification", objective: "Plan",
    confirmed_findings: [], active_hypotheses: [], rejected_hypotheses: [], open_questions: [], blockers: [], relevant_files: [], relevant_symbols: [],
    inspected_refs: [], inspected_files: [], inspected_symbols: [], inspected_commits: [], records: Array.from({ length: 400 }, (_, index) => ({
      id: `M${index + 1}`, kind: "observation", text: `Observation ${index + 1} ${"x".repeat(90)}`, status: "observed", confidence: "medium",
      evidence_refs: [], created_at: now, updated_at: now })), created_at: now, updated_at: now });
  const spec = { revision: 1, summary: "Large spec", created_at: now, requirements: Array.from({ length: 400 }, (_, index) => ({
    id: `R${index + 1}`, statement: `Requirement ${index + 1} ${"y".repeat(90)}`, kind: "behavior" as const, priority: "must" as const })) };
  const response = { active: true, memory: { ...memory, id: undefined, spec }, active_plan: { active: false }, stage: "planning" };
  const initial = pageMemoryCurrent(response, {}) as { memory: { record_ids: string[]; spec: { requirement_ids: string[] } }; continuation: { state_token: string } };
  assert.equal(initial.memory.record_ids.length, 400); assert.equal(initial.memory.spec.requirement_ids.length, 400);
  assert.ok(Buffer.byteLength(formatToolResponse(initial).content[0]!.text) <= 24_000);
  for (const section of ["records", "requirements"] as const) {
    let offset = 0; const ids: string[] = [];
    while (true) {
      const page = pageMemoryCurrent(response, { section, offset, state_token: initial.continuation.state_token }) as { items: Array<{ id: string }>; next_offset: number | null };
      assert.ok(Buffer.byteLength(formatToolResponse(page).content[0]!.text) <= 24_000);
      ids.push(...page.items.map((item) => item.id));
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    assert.deepEqual(ids, Array.from({ length: 400 }, (_, index) => `${section === "records" ? "M" : "R"}${index + 1}`));
  }
  const small = { ...response, memory: { ...response.memory, records: [], spec: { ...spec, requirements: [] } } };
  assert.equal(pageMemoryCurrent(small, {}), small);
  assert.throws(() => pageMemoryCurrent({ ...response, memory: { ...response.memory, records: [] } },
    { section: "records", offset: 0, state_token: initial.continuation.state_token }), /STALE/);
  assert.throws(() => pageMemoryCurrent(response,
    { section: "records", offset: 0, state_token: initial.continuation.state_token }, "another-internal-memory"), /STALE/);
});

test("large plan.current pages preserve write paths and verification IDs", () => {
  const response = { active: true, status: "active", step: { id: "S1", kind: "implementation", title: "Wide step", objective: "Change files",
    covers: ["R1"], writes: Array.from({ length: 20 }, (_, index) => ({ repo: "repo", path: `src/file-${index}.ts`, purpose: "x".repeat(1_000) })),
    context: [], acceptance: Array.from({ length: 20 }, (_, index) => ({ id: `A${index + 1}`, statement: `Check ${index}` })),
    verification: Array.from({ length: 20 }, (_, index) => ({ id: `V${index + 1}`, command: `npm test -- ${index}` })) } };
  const initial = pagePlanCurrent(response, {}) as { step: { write_paths: string[]; verification_ids: string[] };
    continuation: { state_token: string } };
  assert.equal(initial.step.write_paths.length, 20); assert.equal(initial.step.verification_ids.length, 20);
  assert.ok(Buffer.byteLength(formatToolResponse(initial).content[0]!.text) <= 24_000);
  for (const section of ["writes", "verification"] as const) {
    let offset = 0; const items: unknown[] = [];
    while (true) {
      const page = pagePlanCurrent(response, { section, offset, state_token: initial.continuation.state_token }) as { items: unknown[]; next_offset: number | null };
      items.push(...page.items);
      assert.ok(Buffer.byteLength(formatToolResponse(page).content[0]!.text) <= 24_000);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    assert.equal(items.length, 20);
  }
  assert.throws(() => pagePlanCurrent({ ...response, step: { ...response.step, title: "Changed" } },
    { section: "writes", offset: 0, state_token: initial.continuation.state_token }), /STALE/);
  const small = { step: { id: "S1", writes: [], context: [], acceptance: [], verification: [] } };
  assert.equal(pagePlanCurrent(small, {}), small);
});

test("legacy outcome provenance remains readable without guessing types", async () => {
  const env = await isolated("outcome-legacy");
  try {
    const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
    const memory = await tasks.create("planning", "Legacy outcome");
    const raw = JSON.parse(await readFile(tasks.storage.statePath("planning", memory.id), "utf8")) as Record<string, unknown>;
    raw.outcome = { summary: "Done", limitations: [], evidence_refs: ["repo:file.ts", "npm test"], completed_at: new Date().toISOString() };
    await writeFile(tasks.storage.statePath("planning", memory.id), JSON.stringify(raw));
    const outcome = (await tasks.read("planning", memory.id)).outcome!;
    assert.deepEqual(outcome.evidence_refs, []); assert.deepEqual(outcome.modified_paths, []); assert.deepEqual(outcome.verifications, []);
    assert.deepEqual(outcome.legacy_unclassified, ["repo:file.ts", "npm test"]);
  } finally { await env.cleanup(); }
});

test("repo-local Qwen 0.24.7 tool hooks are observable but fail open on hook errors", async () => {
  const chunks = path.join(projectRoot, "docs", "logs", "0.24.7", "libexec", "lib", "node_modules", "@qwen-code", "qwen-code", "chunks");
  const scheduler = await readFile(path.join(chunks, "chunk-AN36BHDM.js"), "utf8");
  const externalGuard = await readFile(path.join(chunks, "external-tool-guard-provider-G7SGGL2X.js"), "utf8");
  const acp = await readFile(path.join(chunks, "acpAgent-UCU7OI47.js"), "utf8");
  const names = await readFile(path.join(chunks, "chunk-NIEO2TBE.js"), "utf8");
  assert.match(scheduler, /eventName:"PreToolUse"/);
  assert.match(scheduler, /eventName:"PostToolUse"/);
  assert.match(scheduler, /eventName:"PostToolUseFailure"/);
  assert.match(scheduler, /tool_name:toolName,tool_input:toolInput,tool_response:toolResponse/);
  assert.match(scheduler, /FS_PATH_TOOL_NAMES=new Set\(\[ToolNames.READ_FILE.*ToolNames.EDIT,ToolNames.WRITE_FILE/);
  assert.match(scheduler, /return\{shouldProceed:true,hookError:message\}/);
  assert.match(scheduler, /return\{shouldStop:false,hookError:message\}/);
  assert.match(acp, /getToolInvocationGuard\?\.\(\)/);
  assert.match(acp, /toolName:policyToolName,args:invocation.params/);
  assert.match(acp, /if\(!options.externalProviderAttached&&!SHELL_EXECUTING_TOOL_NAMES.has\(context.toolName\)\)\{return\{allowed:true\}\}/);
  assert.match(acp, /Required external tool guard is available only to a private managed ACP parent/);
  assert.match(names, /SHELL_EXECUTING_TOOL_NAMES=new Set\(\["monitor","run_shell_command"\]\)/);
  assert.match(externalGuard, /"\/v1\/prepare"/);
  assert.doesNotMatch(externalGuard, /"\/v1\/complete"/);
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
