import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { isolated } from "./helpers.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { TaskService } from "../src/task-state/service.js";
import { PlanStorage } from "../src/plan/storage.js";
import { PlanService } from "../src/plan/service.js";
import { saveConfig } from "../src/config/loader.js";
import { compactPlanStep, planInput } from "../src/mcp/schemas.js";

async function setup(name: string, repoName = "repo") {
  const env = await isolated(name);
  const repo = path.join(env.root, repoName);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.ts"), "export const a = 0;\n");
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  await registry.add("planning", [repo]);
  const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
  const memory = await tasks.create("planning", name);
  await tasks.setSpec("planning", { summary: "Implement behavior", requirements: [
    { statement: "The behavior works", kind: "behavior", priority: "must" },
  ] });
  const plans = new PlanService(new PlanStorage(tasks.storage), tasks, registry);
  return { env, repo, registry, tasks, memory, plans };
}

test("minimal plan derives kind, binds one repo and needs no coverage, verification or tests", async () => {
  const { env, plans } = await setup("minimal-plan");
  try {
    const parsed = planInput.parse({ action: "create", steps: [
      { title: "Change a", objective: "Implement spec", writes: ["src/a.ts"] },
      { title: "Inspect", objective: "Read state" },
    ] });
    if (parsed.action !== "create") throw new Error("Expected create");
    assert.deepEqual(compactPlanStep.keyof().options, ["title", "objective", "writes", "repo"]);
    const plan = await plans.createCompact("planning", parsed.steps);
    assert.equal(plan.steps[0]!.kind, "implementation");
    assert.equal(plan.steps[1]!.kind, "investigation");
    assert.equal(plan.steps[0]!.writes[0]!.repo, "repo");
    assert.deepEqual(plan.steps[0]!.covers, []);
    assert.deepEqual(plan.steps[0]!.verification, []);
    const current = await plans.current("planning", "unknown");
    assert.deepEqual(current.step?.writes, ["src/a.ts"]);
    assert.equal("covers" in current.step!, false);
    assert.equal("verification" in current.step!, false);
    assert.equal(current.guard_status, "unavailable");
  } finally { await env.cleanup(); }
});

test("relative and absolute paths stay canonically inside the active repository", async () => {
  const { env, repo, plans } = await setup("minimal-paths");
  try {
    const outside = path.join(env.root, "outside"); await mkdir(outside);
    await symlink(outside, path.join(repo, "src", "escape"));
    for (const target of [path.join(outside, "x.ts"), "../outside/x.ts", "src/escape/x.ts", "src/escape/new/x.ts", "src/escape/../a.ts"])
      await assert.rejects(plans.createCompact("planning", [{ title: "Bad", objective: "Escape", writes: [target] }]), /escapes/i);
    const plan = await plans.createCompact("planning", [{ title: "Good", objective: "Create files", writes: [
      "src/../src/a.ts", path.join(repo, "src", "new", "deep.ts"),
    ] }]);
    assert.deepEqual(plan.steps[0]!.writes.map((item) => item.path), ["src/a.ts", "src/new/deep.ts"]);
  } finally { await env.cleanup(); }
});

test("project-v1 absolute and relative writes share one repo-relative identity and baseline", async () => {
  const { env, repo, plans } = await setup("project-v1-paths", "project-v1");
  try {
    const relative = "src/app/foo.ts"; const absolute = path.join(repo, relative);
    const outside = path.join(env.root, "outside.ts");
    const sibling = path.join(env.root, "project-v2", "src", "foo.ts");
    await mkdir(path.dirname(sibling), { recursive: true });
    await symlink(path.join(env.root, "project-v2"), path.join(repo, "src", "escape"));
    const duplicatedLocation = path.join(repo, "project-v1", relative);
    await mkdir(path.dirname(duplicatedLocation), { recursive: true });
    await writeFile(duplicatedLocation, "wrong baseline target\n");
    for (const forbidden of [outside, sibling, "src/escape/src/foo.ts"])
      await assert.rejects(plans.createCompact("planning", [{ title: "Bad", objective: "Outside repo", writes: [forbidden] }]), /escapes/i);
    const plan = await plans.createCompact("planning", [{ title: "Add foo", objective: "Create file", writes: [relative, absolute] }]);
    const step = plan.steps[0]!;
    assert.deepEqual(step.writes.map(({ repo: id, path: target }) => ({ repo: id, path: target })),
      [{ repo: "project-v1", path: relative }]);
    assert.deepEqual(step.write_baseline?.map(({ repo: id, path: target, state }) => ({ repo: id, path: target, state: state.kind })),
      [{ repo: "project-v1", path: relative, state: "missing" }]);
    assert.deepEqual(step.plan_baseline?.map(({ path: target }) => target), [relative]);
    assert.ok(!step.writes.some((write) => write.path === "project-v1/src/app/foo.ts"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "export const foo = true;\n");
    const result = await plans.completeCurrent("planning") as { advanced: boolean; content_delta_verified: boolean };
    assert.equal(result.advanced, true);
    assert.equal(result.content_delta_verified, true);
    assert.deepEqual((await plans.state("planning")).plan!.steps[0]!.modified_paths,
      [{ repo: "project-v1", path: relative }]);
  } finally { await env.cleanup(); }
});

test("correcting a duplicated persisted write retains plan creation evidence without a second edit", async () => {
  const { env, repo, plans } = await setup("project-v1-revision", "project-v1");
  try {
    const relative = "src/app/foo.ts";
    const malformed = "project-v1/src/app/foo.ts";
    const plan = await plans.createCompact("planning", [{ title: "Add foo", objective: "Create file", writes: [relative] }]);
    assert.equal(plan.steps[0]!.plan_baseline?.[0]?.state.kind, "missing");
    assert.ok(plan.repository_baseline?.some((item) => item.repo === "project-v1" && !item.files.some((file) => file.path === relative)));
    // Simulate a plan persisted by a host version that prepended the repo ID.
    plan.steps[0]!.writes[0]!.path = malformed;
    plan.steps[0]!.write_baseline![0]!.path = malformed;
    plan.steps[0]!.plan_baseline![0]!.path = malformed;
    const actual = path.join(repo, relative);
    await mkdir(path.dirname(actual), { recursive: true });
    await writeFile(actual, "export const foo = true;\n");
    plan.steps[0]!.modified_paths = [{ repo: "project-v1", path: malformed }];
    plan.steps[0]!.mutation_generation = 1;
    await plans.storage.write("planning", plan);
    const revised = await plans.reviseCurrentCompact("planning", "Correct the repo-relative write path", {
      title: "Add foo", objective: "Create file", writes: [actual],
    });
    assert.deepEqual(revised.steps[0]!.writes.map((write) => write.path), [relative]);
    assert.deepEqual(revised.steps[0]!.modified_paths, [{ repo: "project-v1", path: relative }]);
    assert.equal(revised.steps[0]!.mutation_generation, 1);
    assert.deepEqual(revised.steps[0]!.write_baseline?.map((item) => item.state.kind), ["file"]);
    assert.deepEqual(revised.steps[0]!.plan_baseline?.map((item) => item.state.kind), ["missing"]);
    const result = await plans.completeCurrent("planning") as { advanced: boolean; content_delta_verified: boolean };
    assert.equal(result.advanced, true);
    assert.equal(result.content_delta_verified, true);
    assert.deepEqual((await plans.state("planning")).plan!.steps[0]!.modified_paths,
      [{ repo: "project-v1", path: relative }]);
  } finally { await env.cleanup(); }
});

test("multiple repositories require an owner for unqualified writes", async () => {
  const { env, registry, plans } = await setup("minimal-multi-repo");
  try {
    const second = path.join(env.root, "second"); await mkdir(second);
    await registry.addRepository("planning", second, "second");
    await assert.rejects(plans.createCompact("planning", [{ title: "Write", objective: "Change", writes: ["src/new.ts"] }]), /Resolve write owner/);
    await assert.rejects(plans.createCompact("planning", [{ title: "Write", objective: "Change", writes: ["src/new.ts"], repo: "invented" }]), /not registered/);
    const plan = await plans.createCompact("planning", [{ title: "Write", objective: "Change", writes: ["src/new.ts"], repo: "repo" }]);
    assert.equal(plan.steps[0]!.writes[0]!.repo, "repo");
  } finally { await env.cleanup(); }
});

test("plan baseline accepts an earlier task edit, but restores, no-op rewrites and unrelated edits do not count", async () => {
  const { env, repo, plans } = await setup("minimal-delta");
  try {
    const a = path.join(repo, "src", "a.ts"); const b = path.join(repo, "src", "b.ts");
    const plan = await plans.createCompact("planning", [
      { title: "Change a", objective: "First", writes: ["src/a.ts"] },
      { title: "Change b", objective: "Second", writes: ["src/b.ts"] },
    ]);
    await writeFile(a, await readFile(a));
    await writeFile(path.join(repo, "src", "unrelated.ts"), "unrelated\n");
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, false);
    await writeFile(a, "export const a = 1;\n");
    await writeFile(a, "export const a = 0;\n");
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, false);
    await writeFile(b, "export const b = 1;\n"); // before S2's baseline
    await writeFile(a, "export const a = 2;\n");
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, true);
    assert.equal(plan.steps[1]!.write_baseline, undefined);
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, true);
    assert.deepEqual((await plans.state("planning")).plan!.steps[1]!.modified_paths, [{ repo: "repo", path: "src/b.ts" }]);
  } finally { await env.cleanup(); }
});

test("operator accepted no-change path advances without a manufactured edit", async () => {
  const { env, plans, memory } = await setup("minimal-no-change");
  try {
    await plans.createCompact("planning", [{ title: "Ensure a", objective: "Already satisfied", writes: ["src/a.ts"] }]);
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, false);
    await plans.markWriteNotNeeded("planning", memory.id, "repo", "src/a.ts", "Operator inspected the existing implementation");
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, true);
  } finally { await env.cleanup(); }
});

test("server executes configured lint, records failure and reruns for changed content under isolated HOME", async () => {
  const { env, repo, plans, registry } = await setup("minimal-checks");
  try {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: {
      lint: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/a.ts','utf8').includes('bad') || !process.env.HOME.includes('verification-home') || fs.existsSync(process.env.HOME+'/.angular-config.json') ? 1 : 0)\"",
    } }));
    const config = await registry.config(); config.workspaces[0]!.verification = ["lint", "typecheck", "build"];
    await saveConfig(config, env.config);
    await plans.createCompact("planning", [{ title: "Change a", objective: "Lint it", writes: ["src/a.ts"] }]);
    await writeFile(path.join(repo, "src", "a.ts"), "bad\n");
    let result = await plans.completeCurrent("planning") as { advanced: boolean; missing: string[] };
    assert.equal(result.advanced, false); assert.match(result.missing.join("\n"), /npm run lint failed/);
    assert.equal((await plans.state("planning")).plan!.steps[0]!.check_receipts?.[0]?.exit_code, 1);
    await writeFile(path.join(repo, "src", "a.ts"), "good\n");
    assert.equal((await plans.current("planning")).step?.required_checks[0]?.current, false);
    result = await plans.completeCurrent("planning") as typeof result;
    assert.equal(result.advanced, true);
    assert.equal((await plans.state("planning")).plan!.steps[0]!.check_receipts?.[0]?.exit_code, 0);
    assert.equal((await plans.state("planning")).plan!.steps[0]!.check_receipts?.length, 1, "missing scripts are omitted");
  } finally { await env.cleanup(); }
});

test("server check receipt is tied to current repository content and reruns after edits", async () => {
  const { env, repo, plans, registry } = await setup("minimal-check-freshness");
  try {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { lint: "node -e \"process.exit(0)\"" } }));
    const config = await registry.config(); config.workspaces[0]!.verification = ["lint"]; await saveConfig(config, env.config);
    await plans.createCompact("planning", [{ kind: "implementation", title: "Legacy", objective: "Change a", covers: ["R1"],
      writes: [{ repo: "repo", path: "src/a.ts" }], acceptance: ["Works"],
      verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, false, "legacy verification still blocks");
    const first = (await plans.state("planning")).plan!.steps[0]!.check_receipts![0]!.content_hash;
    assert.equal((await plans.current("planning")).step?.required_checks[0]?.current, true);
    await writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
    assert.equal((await plans.current("planning")).step?.required_checks[0]?.current, false);
    assert.equal((await plans.completeCurrent("planning") as { advanced: boolean }).advanced, false);
    const second = (await plans.state("planning")).plan!.steps[0]!.check_receipts![0]!.content_hash;
    assert.notEqual(first, second);
  } finally { await env.cleanup(); }
});
