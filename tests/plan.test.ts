import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ToolRuntime } from "../src/mcp/runtime.js";
import { PlanGuard } from "../src/plan/guard.js";
import { PlanService } from "../src/plan/service.js";
import { PlanStorage } from "../src/plan/storage.js";
import { TaskService } from "../src/task-state/service.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { pluginSource } from "../src/integrations/templates.js";
import { fixture, fixtureWorkspace, isolated, projectRoot } from "./helpers.js";

const step = (id: string, repo: string, file: string, command: string) => ({
  id, kind: "implementation" as const, title: `Implement ${id}`, objective: `Complete ${id} without unrelated changes`, covers: ["R1"],
  writes: [{ repo, path: file, covers: ["R1"] }], context: [{ repo, file }], acceptance: [{ statement: `${id} behavior is correct`, covers: ["R1"] }],
  verification: [{ command, expect_exit: 0 }],
});

test("plan requires active memory and confirmed spec, binds the hash internally, and survives restart", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE; const env = await fixtureWorkspace("plan-lifecycle");
  try {
    const runtime = new ToolRuntime(); const steps = [step("S1", "backend", "src/PlanningService.ts", "npm test -- backend"), step("S2", "shared", "src/duration.ts", "npm test -- shared")];
    await assert.rejects(runtime.plan({ action: "create", steps }), /active memory/);
    await runtime.tasks.create("planning", "Duration work");
    await assert.rejects(runtime.plan({ action: "create", steps }), /confirmed spec/);
    await runtime.tasks.update("planning", undefined, { spec: "Duration calculations preserve existing behavior." });
    const created = await runtime.plan({ action: "create", steps }) as any;
    assert.equal(created.active, true); assert.equal(created.step.id, "S1"); assert.equal(created.total, 2);
    assert.deepEqual(created.step.acceptance[0], { id: "A1", statement: "S1 behavior is correct", covers: ["R1"], verification_ids: ["V1"] });
    assert.doesNotMatch(JSON.stringify(created), /S2 behavior|npm test -- shared/);
    const state = await runtime.plans.state("planning"); assert.match(state.plan?.spec_hash || "", /^[a-f0-9]{64}$/);
    const restarted = new ToolRuntime(); const resumed = await restarted.plan({ action: "current" }) as any;
    assert.equal(resumed.active, true); assert.equal(resumed.step.id, "S1");
  } finally {
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
    await env.cleanup();
  }
});

test("PlanGuard enforces current scope, generations, verification freshness, advancement, staleness, and revision", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE; const env = await fixtureWorkspace("plan-guard");
  const editedFile = fixture("backend/src/PlanningService.ts"); const originalSource = await readFile(editedFile, "utf8");
  try {
    const runtime = new ToolRuntime(); await runtime.tasks.create("planning", "Guarded duration");
    await runtime.tasks.update("planning", undefined, { spec: "Implement and verify duration changes." });
    const first = step("S1", "backend", "src/PlanningService.ts", "npm test -- backend");
    const second = step("S2", "shared", "src/duration.ts", "npm test -- shared");
    await runtime.plan({ action: "create", steps: [first, second] });
    const guard = new PlanGuard(runtime.plans, runtime.registry);
    assert.equal((await guard.beforeMutation("planning", [fixture("backend/src/PlanningService.ts")])).allowed, true);
    const denied = await guard.beforeMutation("planning", [fixture("shared/src/duration.ts")]);
    assert.equal(denied.allowed, false); assert.match(denied.reason || "", /does not authorize/);
    assert.equal((await guard.beforeShell("planning", "echo changed > src/PlanningService.ts")).allowed, false);

    assert.equal(await guard.afterVerification("planning", "npm test -- backend", 0), true);
    await writeFile(editedFile, `${originalSource}\n// guarded mutation\n`);
    await guard.afterMutation("planning");
    let completion = await runtime.plan({ action: "complete", evidence: "tests passed", verified_generation: 1 } as any) as any;
    assert.equal(completion.advanced, false); assert.match(completion.missing.join("\n"), /generation 1/);
    await guard.afterVerification("planning", "npm test -- backend", 1);
    completion = await runtime.plan({ action: "complete" }) as any; assert.equal(completion.advanced, false);
    await guard.afterVerification("planning", "npm test -- backend", 0);
    completion = await runtime.plan({ action: "complete" }) as any;
    assert.deepEqual({ advanced: completion.advanced, completed: completion.completed_step, current: completion.current_step }, { advanced: true, completed: "S1", current: "S2" });
    assert.equal(((await runtime.plan({ action: "current" })) as any).step.id, "S2", "the model cannot select or skip the server-owned step");

    await runtime.tasks.update("planning", undefined, { spec: "The confirmed specification changed." });
    assert.equal((await guard.beforeMutation("planning", [fixture("shared/src/duration.ts")])).allowed, false);
    completion = await runtime.plan({ action: "complete" }) as any; assert.equal(completion.advanced, false); assert.match(completion.missing.join("\n"), /stale/);
    const { id: _serverId, ...replacement } = second;
    const revised = await runtime.plan({ action: "revise", reason: "Spec changed and S2 remains the bounded implementation target",
      operations: [{ op: "replace_current", step: replacement }] }) as any;
    assert.equal(revised.revision, 2); assert.equal(revised.stale, false); assert.equal(revised.step.id, "S2");
  } finally {
    await writeFile(editedFile, originalSource);
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
    await env.cleanup();
  }
});

test("installed OpenCode execute.before hook denies an actual out-of-step editor request", async () => {
  const originalWorkspace = process.env.CODE_INTELLIGENCE_WORKSPACE; const originalPath = process.env.PATH;
  const env = await fixtureWorkspace("plan-opencode-hook");
  const editedFile = fixture("backend/src/PlanningService.ts"); const originalSource = await readFile(editedFile, "utf8");
  try {
    const runtime = new ToolRuntime(); await runtime.tasks.create("planning", "Hook guard");
    await runtime.tasks.update("planning", undefined, { spec: "Only the current backend file may change." });
    await runtime.plan({ action: "create", steps: [step("S1", "backend", "src/PlanningService.ts", "npm test -- backend")] });
    const bin = path.join(env.root, "bin"); await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "code-intelligence");
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(projectRoot, "dist/src/cli/main.js"))} "$@"\n`);
    await chmod(executable, 0o700); process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
    const pluginFile = path.join(env.root, "plugin.mjs");
    await writeFile(pluginFile, pluginSource.replaceAll("__CODE_INTELLIGENCE_WORKSPACE__", "planning"));
    const before: Array<(event: any) => Promise<void>> = []; const after: Array<(event: any) => Promise<void>> = [];
    const plugin = (await import(`${pathToFileURL(pluginFile).href}?v=${Date.now()}`)).default;
    await plugin.setup({ location: { directory: fixture("backend") }, session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async (name: string, handler: (event: any) => Promise<void>) => { if (name === "execute.before") before.push(handler); if (name === "execute.after") after.push(handler); return { dispose: async () => {} }; } } });
    assert.equal(before.length, 1); assert.equal(after.length, 1);
    await before[0]!({ tool: "edit", input: { filePath: fixture("backend/src/PlanningService.ts") } });
    await assert.rejects(before[0]!({ tool: "edit", input: { filePath: fixture("shared/src/duration.ts") } }), /does not authorize shared:src\/duration\.ts/);
    await writeFile(editedFile, `${originalSource}\n// plugin mutation\n`);
    await after[0]!({ tool: "edit", status: "completed", input: { filePath: editedFile }, result: {} });
    await before[0]!({ tool: "execute", input: { code: "npm test -- backend" } });
    await after[0]!({ tool: "execute", status: "completed", input: { code: "npm test -- backend" }, result: { output: { ok: true } } });
    assert.equal(((await runtime.plan({ action: "complete" })) as any).advanced, true, "the after hook records fresh mechanical verification");
  } finally {
    await writeFile(editedFile, originalSource);
    process.env.PATH = originalPath;
    if (originalWorkspace === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = originalWorkspace;
    await env.cleanup();
  }
});

test("plan paths reject unknown repositories, traversal, absolute and symlink escapes, and require justification for 3+ writes", async () => {
  const env = await isolated("plan-paths");
  try {
    const repo = path.join(env.root, "repo"); const outside = path.join(env.root, "outside.ts");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await Promise.all(["a.ts", "b.ts", "c.ts"].map((name) => writeFile(path.join(repo, "src", name), "export {};\n")));
    await writeFile(outside, "secret\n"); await symlink(outside, path.join(repo, "src", "escape.ts"));
    const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces")); await registry.add("planning", [repo]);
    const taskStorage = new TaskStorage(path.join(env.data, "workspaces")); const tasks = new TaskService(taskStorage);
    await tasks.create("planning", "Path validation"); await tasks.update("planning", undefined, { spec: "Only bounded registered repository paths may be changed." });
    const plans = new PlanService(new PlanStorage(taskStorage), tasks, registry);
    const base = step("S1", "repo", "src/a.ts", "npm test");
    await assert.rejects(plans.create("planning", [{ ...base, writes: [{ repo: "missing", path: "src/a.ts" }] }]), /Unknown repository/);
    await assert.rejects(plans.create("planning", [{ ...base, writes: [{ repo: "repo", path: "../outside.ts" }] }]), /escapes/);
    await assert.rejects(plans.create("planning", [{ ...base, writes: [{ repo: "repo", path: outside }] }]), /Absolute/);
    await assert.rejects(plans.create("planning", [{ ...base, writes: [{ repo: "repo", path: "src/escape.ts" }] }]), /Symlink escapes/);
    const writes = ["a.ts", "b.ts", "c.ts"].map((name) => ({ repo: "repo", path: `src/${name}`, covers: ["R1"] }));
    await assert.rejects(plans.create("planning", [{ ...base, writes }]), /3 or more writable files require/);
    const accepted = await plans.create("planning", [{ ...base, writes, multi_file_justification: "One atomic generated contract update across three tightly coupled files." }]);
    assert.equal(accepted.steps[0]?.writes.length, 3);
    const symlinkMutation = await new PlanGuard(plans, registry).beforeMutation("planning", [path.join(repo, "src", "escape.ts")]);
    assert.equal(symlinkMutation.allowed, false); assert.match(symlinkMutation.reason || "", /Symlink escapes the repository/);
  } finally { await env.cleanup(); }
});

test("future nested write paths resolve through safe ancestors and match guard targets", async () => {
  const env = await isolated("plan-future-paths");
  try {
    const repo = path.join(env.root, "repo"); const outside = path.join(env.root, "outside");
    await mkdir(path.join(repo, "src"), { recursive: true }); await mkdir(outside);
    await symlink(outside, path.join(repo, "src", "escape"));
    await symlink(path.join(repo, "src"), path.join(repo, "alias"));
    await mkdir(path.join(repo, "src", "private"));
    await symlink(path.join(repo, "src", "private"), path.join(repo, "public-alias"));
    await writeFile(path.join(repo, "src", "file.ts"), "export const file = true;\n");
    await writeFile(path.join(repo, ".codeintelligenceignore"), "src/private/**\n");
    const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces")); await registry.add("planning", [repo]);
    const taskStorage = new TaskStorage(path.join(env.data, "workspaces")); const tasks = new TaskService(taskStorage);
    await tasks.create("planning", "Future path");
    await tasks.replaceSpec("planning", undefined, { summary: "Add a bounded file", requirements: [{ statement: "New file is verified", kind: "behavior", priority: "must" }] });
    const plans = new PlanService(new PlanStorage(taskStorage), tasks, registry);
    const target = "src/new/deep/feature.ts";
    const future = { kind: "implementation" as const, title: "Add file", objective: "Create one verified file", covers: ["R1"],
      writes: [{ repo: "repo", path: target, covers: ["R1"] }], acceptance: [{ statement: "File verified", covers: ["R1"] }],
      verification: [{ kind: "test" as const, program: "node", args: ["--test"], repo: "repo" }] };
    await assert.rejects(plans.create("planning", [{ ...future, writes: [{ repo: "repo", path: "src/escape/deep/file.ts", covers: ["R1"] }] }]), /Symlink escapes/);
    await assert.rejects(plans.create("planning", [{ ...future, writes: [{ repo: "repo", path: "src/private/deep/file.ts", covers: ["R1"] }] }]), /excluded/);
    await assert.rejects(plans.create("planning", [{ ...future, writes: [{ repo: "repo", path: "public-alias/deep/file.ts", covers: ["R1"] }] }]), /excluded/);
    await assert.rejects(plans.create("planning", [{ ...future, writes: [{ repo: "repo", path: "src/file.ts/deep/file.ts", covers: ["R1"] }] }]), /non-directory ancestor/);
    await plans.create("planning", [future]);
    const guard = new PlanGuard(plans, registry);
    assert.equal((await guard.beforeMutation("planning", [path.join(repo, target)])).allowed, true);
    assert.equal((await guard.beforeMutation("planning", [path.join(repo, "alias", "new", "deep", "feature.ts")])).allowed, true);
    await mkdir(path.join(repo, "src", "new", "deep"), { recursive: true });
    await writeFile(path.join(repo, target), "export const feature = true;\n");
    assert.equal(await guard.afterMutation("planning", [path.join(repo, target)]), true);
    const current = await plans.current("planning"); assert.deepEqual(current.step?.modified_paths, [{ repo: "repo", path: target }]);
  } finally { await env.cleanup(); }
});
