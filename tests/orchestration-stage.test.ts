import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTree } from "jsonc-parser";
import { deriveStage } from "../src/orchestration/stage.js";
import { ToolRuntime } from "../src/mcp/runtime.js";
import { PlanGuard } from "../src/plan/guard.js";
import { fixture, fixtureWorkspace, projectRoot } from "./helpers.js";

const root = path.join(projectRoot, "docs/qwen-skills");
const names = ["investigation", "specification", "planning", "implementation"];

test("four Qwen 0.24.7 skills are model-invocable and define the required transitions", async () => {
  const bodies = await Promise.all(names.map((name) => readFile(path.join(root, `code-intelligence-${name}`, "SKILL.md"), "utf8")));
  for (const [index, body] of bodies.entries()) {
    assert.match(body, new RegExp(`^---\\nname: code-intelligence-${names[index]}\\ndescription: [^\\n]+\\n---\\n`));
    assert.doesNotMatch(body, /disable-model-invocation: true|user-invocable: false|paths:/);
  }
  assert.match(bodies[2]!, /EnterPlanMode.*ExitPlanMode/);
  assert.match(bodies[2]!, /action: create[\s\S]*action: current/);
  assert.match(bodies[3]!, /Before ANY code mutation call Code Intelligence `plan\.current`/);
  assert.match(bodies[3]!, /code-review-and-quality[\s\S]*plan\.complete_current/);
  assert.match(bodies[3]!, /cumulative plan delta[\s\S]*external review receipt/);
});

test("Qwen settings example has unique keys and keeps model skills and MCP plan visible", async () => {
  const settings = await readFile(path.join(root, "qwen-settings.example.jsonc"), "utf8");
  const tree = parseTree(settings)!;
  const check = (node: typeof tree) => {
    if (node.type === "object") {
      const keys = node.children!.map((property) => String(property.children![0]!.value));
      assert.equal(new Set(keys).size, keys.length);
    }
    node.children?.forEach(check);
  };
  check(tree);
  const value = JSON.parse(settings);
  assert.deepEqual(value.tools.disabled, ["enter_plan_mode", "exit_plan_mode"]);
  assert.ok(!value.tools.disabled.includes("skill"));
  assert.ok(!value.skills.disabledLevels.includes("user"));
  assert.ok(value.tools.visible.includes("skill"));
  assert.ok(value.tools.visible.includes("mcp__code-intelligence__memory"));
  assert.ok(value.tools.visible.includes("mcp__code-intelligence__plan"));
  assert.equal((settings.match(/"visible"\s*:/g) || []).length, 1);
});

test("Qwen 0.24.7 captured source proves native plan identifiers and skill invocation settings", async () => {
  const captured = path.join(projectRoot, "docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code");
  const [tools, settings, skills] = await Promise.all([
    readFile(path.join(captured, "chunks/chunk-HQTIBNDS.js"), "utf8"),
    readFile(path.join(captured, "bundled/qc-helper/docs/configuration/settings.md"), "utf8"),
    readFile(path.join(captured, "bundled/qc-helper/docs/features/skills.md"), "utf8"),
  ]);
  assert.match(tools, /EXIT_PLAN_MODE:"exit_plan_mode",ENTER_PLAN_MODE:"enter_plan_mode"/);
  assert.match(tools, /SKILL:"skill"/);
  assert.match(settings, /`tools\.disabled`[^\n]*Tool names hidden from the registry entirely/);
  assert.match(settings, /`skills\.disabledLevels`[^\n]*`user`/);
  assert.match(skills, /hide a Skill from model invocation[\s\S]*disable-model-invocation: true/);
});

test("persisted evidence, spec, plan and review state derive stage; plan guard blocks missing and stale plans", async () => {
  const old = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("orchestration-stage");
  try {
    const runtime = new ToolRuntime();
    const stage = () => deriveStage(runtime.plans, "planning");
    assert.equal((await stage()).stage, "operator_action_required");
    await runtime.tasks.create("planning", "Orchestration work");
    assert.equal((await stage()).required_skill, "code-intelligence-investigation");
    const ref = "code://backend/src/PlanningService.ts#L=1-2";
    await runtime.tasks.recordInspection("planning", { ref, repo: "backend", files: ["src/PlanningService.ts"], symbols: [] });
    await runtime.tasks.note("planning", { type: "evidence", text: "Inspected behavior", confidence: "high", evidence_refs: [ref] });
    assert.equal((await stage()).required_skill, "code-intelligence-investigation", "one finding does not imply sufficient investigation");
    await runtime.tasks.note("planning", { type: "decision", text: "Evidence supports a complete observable spec", confidence: "high", evidence_refs: [ref] });
    await runtime.tasks.resolve("planning", "M2", "confirmed", "Investigated behavior and its boundary", [ref]);
    assert.equal((await stage()).required_skill, "code-intelligence-specification");
    await runtime.tasks.setSpec("planning", { summary: "Implement behavior", requirements: [{ statement: "The behavior is verified", kind: "behavior", priority: "must" }] });
    assert.equal((await stage()).required_skill, "code-intelligence-planning");
    const guard = new PlanGuard(runtime.plans, runtime.registry);
    const target = fixture("backend/src/PlanningService.ts");
    assert.match((await guard.beforeMutation("planning", [target])).reason || "", /^PLAN_REQUIRED:/);
    assert.match((await guard.beforeShell("planning", "echo change > src/PlanningService.ts")).reason || "", /^PLAN_REQUIRED:/);
    assert.equal((await guard.beforeShell("planning", "npm test")).allowed, true);
    const current = await runtime.memory({ action: "current" }) as any;
    assert.equal(current.required_skill, "code-intelligence-planning");
    await runtime.plan({ action: "create", steps: [{ kind: "implementation", title: "Implement behavior", objective: "Make behavior verified", covers: ["R1"],
      writes: [{ repo: "backend", path: "src/PlanningService.ts" }], acceptance: ["Behavior is verified"],
      verification: [{ kind: "test", program: "npm", args: ["test"], repo: "backend" }] }] });
    assert.equal((await stage()).required_skill, "code-intelligence-implementation");
    assert.equal((await guard.beforeMutation("planning", [target])).allowed, true);
    const plan = (await runtime.plans.state("planning")).plan!;
    plan.steps[plan.current_step]!.status = "pending";
    await runtime.plans.storage.write("planning", plan);
    assert.equal((await stage()).stage, "operator_action_required");
    assert.equal((await guard.beforeMutation("planning", [target])).allowed, false);
    plan.steps[plan.current_step]!.status = "current";
    plan.status = "final_review";
    await runtime.plans.storage.write("planning", plan);
    assert.equal((await stage()).required_skill, "code-review-and-quality");
    assert.equal(((await runtime.plan({ action: "current" })) as any).stage, "final_review");
    await runtime.tasks.setSpec("planning", { summary: "Changed behavior", requirements: [{ id: "R1", statement: "The changed behavior is verified", kind: "behavior", priority: "must" }] });
    assert.equal((await stage()).stage, "operator_action_required");
    assert.equal((await guard.beforeMutation("planning", [target])).allowed, false);
  } finally {
    if (old === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = old;
    await env.cleanup();
  }
});
