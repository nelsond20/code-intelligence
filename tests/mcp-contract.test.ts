import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createMcpServer } from "../src/mcp/server.js";
import { fixtureWorkspace, isolated } from "./helpers.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { TaskService } from "../src/task-state/service.js";
import { PlanService } from "../src/plan/service.js";

async function connectedClient(name = "qwen-code") {
  const server = createMcpServer();
  const client = new Client({ name, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
    return { ...body, isError: Boolean(result.isError) };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

test("tools/list publishes a flat four-action memory schema", async () => {
  const { client, close } = await connectedClient();
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((item) => item.name), ["context.find", "context.inspect", "memory", "plan"]);
    const memory = tools.find((item) => item.name === "memory")!;
    const plan = tools.find((item) => item.name === "plan")!;
    assert.match(memory.description!.slice(0, 70), /"action":"current"/);
    assert.match(memory.description!, /"action":"spec_set"/);
    assert.match(memory.description!, /never send memory_id/);
    assert.match(plan.description!, /"action":"create","steps"/);
    assert.deepEqual((memory.inputSchema.properties?.action as { enum: string[] }).enum, ["current", "note", "resolve", "spec_set"]);
    for (const key of ["anyOf", "oneOf", "allOf", "if", "then"]) assert.equal((memory.inputSchema as Record<string, unknown>)[key], undefined);
    assert.deepEqual(memory.inputSchema.required, ["action"]);
    assert.equal(memory.inputSchema.additionalProperties, false);
    assert.deepEqual((plan.inputSchema.properties?.action as { enum: string[] }).enum, ["current", "create", "complete_current", "revise_current"]);
    const memoryRoot = memory.inputSchema.properties as Record<string, any>;
    const planRoot = plan.inputSchema.properties as Record<string, any>;
    assert.ok(memoryRoot.summary && memoryRoot.requirements && memoryRoot.type && memoryRoot.record_id);
    assert.equal(memoryRoot.title, undefined);
    assert.equal(memoryRoot.state, undefined); assert.equal(memoryRoot.context, undefined);
    assert.deepEqual(memoryRoot.requirements.items.required, ["statement", "kind", "priority"]);
    assert.deepEqual(memoryRoot.requirements.items.properties.kind.enum, ["behavior", "constraint"]);
    assert.deepEqual(memoryRoot.requirements.items.properties.priority.enum, ["must", "should"]);
    assert.match(memoryRoot.requirements.description, /Each item requires statement, kind, and priority/);
    for (const field of ["statement", "kind", "priority", "id"]) assert.ok(memoryRoot.requirements.items.properties[field].description);
    assert.match(memoryRoot.requirements.items.properties.priority.description, /lowercase must or should/);
    assert.match(memoryRoot.requirements.items.properties.id.description, /Omit for a new requirement/);
    assert.ok(planRoot.steps && !planRoot.title && !planRoot.description);
    assert.deepEqual(planRoot.steps.items.required, ["kind", "title", "objective", "covers", "acceptance", "verification"]);
    assert.equal(planRoot.steps.items.properties.acceptance.items.type, "string");
    assert.ok(planRoot.steps.items.properties.verification.items.properties.program);
    assert.equal(plan.inputSchema.type, "object");
    assert.doesNotMatch(JSON.stringify(memory.inputSchema), /"workspace":/);
    const planBranches = plan.inputSchema.anyOf as Array<{ properties: Record<string, any>; required: string[] }>;
    const create = planBranches.find((item) => item.properties.action.const === "create")!;
    assert.ok(create.properties.steps.items.properties.kind.description.includes("investigation"));
    assert.ok(create.properties.steps.items.properties.covers.description.includes("R*"));
    const validator = new AjvJsonSchemaValidator();
    const memoryCheck = validator.getValidator(memory.inputSchema);
    const planCheck = validator.getValidator(plan.inputSchema);
    const requirement = { statement: "preflightSentinel returns true only for ready", kind: "constraint", priority: "must" };
    const investigation = { kind: "investigation", title: "Inspect sentinel", objective: "Find evidence", covers: ["R1"],
      acceptance: ["Evidence found"], verification: [{ kind: "custom", program: "node", args: ["--version"] }] };
    assert.equal(memoryCheck({ action: "current" }).valid, true);
    assert.equal(memoryCheck({ action: "note", type: "observation", text: "Observed", memory_id: "other-memory" }).valid, false);
    assert.equal(memoryCheck({ action: "spec_set", summary: "Sentinel constraint", requirements: [requirement] }).valid, true);
    assert.equal(memoryCheck({ action: "spec_set", summary: "Sentinel constraint", requirements: [{ ...requirement, id: "MEM-1" }] }).valid, false);
    assert.equal(memoryCheck({ action: "spec_set", summary: "Sentinel constraint", requirements: [{ ...requirement, priority: "MUST" }] }).valid, false);
    assert.equal(memoryCheck({ action: "spec_set", summary: "Sentinel constraint", requirements: [{ statement: requirement.statement, priority: "must" }] }).valid, false);
    assert.equal(planCheck({ action: "create", steps: [investigation] }).valid, true);
    for (const field of ["memory_id", "plan_id", "workspace", "spec_revision", "spec_hash"]) assert.equal(planCheck({ action: "create", steps: [investigation], [field]: "forged" }).valid, false);
    assert.equal(planCheck({ action: "create", steps: [{ ...investigation, id: "S1" }] }).valid, false);
    for (const action of ["complete", "revise", "suspend", "reactivate", "abandon"]) assert.equal(planCheck({ action }).valid, false);
    for (const claim of ["review_passed", "reviewed", "blocking_findings"]) assert.equal(planCheck({ action: "complete_current", [claim]: true }).valid, false);
    assert.equal(memoryCheck({ action: "new", title: "Preflight" }).valid, false);
    assert.equal(memoryCheck({ action: "spec_set", title: "Wrong", requirements: [{ id: "req-001", type: "constraint", severity: "MUST", description: "Invented" }] }).valid, false);
    assert.equal(planCheck({ action: "create", title: "Wrong", steps: [{ id: "step-1", kind: "investigation", description: "Invented", writes: [] }] }).valid, false);
  } finally { await close(); }
});

test("context.find excludes the in-workspace Code Intelligence runtime", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await isolated("mcp-runtime-exclusion");
  const workspace = path.join(env.root, "workspace");
  const runtime = path.join(workspace, ".ci-runtime");
  const { call, close } = await connectedClient();
  try {
    await mkdir(path.join(runtime, "data", "workspaces", "planning", "tasks", "one"), { recursive: true });
    await writeFile(path.join(workspace, "sentinel.mjs"), "export function preflightSentinel() { return true; }\n");
    for (const relative of ["config.toml", "data/workspaces/planning/tasks/one/state.json", "data/workspaces/planning/tasks/one/findings.md", "data/workspaces/planning/tasks/one/spec.md"]) {
      await writeFile(path.join(runtime, relative), "preflightSentinel from internal runtime\n");
    }
    const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
    await registry.add("planning", [workspace]);
    process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
    const found = await call("context.find", { query: "preflightSentinel", sources: ["code"], limit: 20 });
    assert.equal(found.status, "ok");
    assert.ok(found.data.results.length > 0);
    assert.ok(found.data.results.every((item: any) => item.metadata.path === "sentinel.mjs"));
    assert.ok(found.data.results.every((item: any) => !item.snippet.includes("internal runtime")));
    const forged = await call("context.inspect", { ref: "code://workspace/.ci-runtime/config.toml#L=1-1" });
    assert.equal(forged.code, "SECURITY_VIOLATION");
  } finally {
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await close(); await env.cleanup();
  }
});

test("MCP preflight and evidence flow are self-contained and reject misleading near-miss inputs", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-contract-flow");
  const { call, close } = await connectedClient();
  try {
    const empty = await call("memory", { action: "current" });
    assert.equal(empty.code, "NO_ACTIVE_MEMORY");
    assert.equal(empty.stage, "operator_action_required");
    assert.match(empty.next_action, /operator/);
    let response = await call("memory", { action: "create", title: "Wrong discriminator" });
    assert.equal(response.code, "INVALID_MEMORY_ACTION_PAYLOAD"); assert.match(response.message, /memory.create/); assert.equal(response.diagnostics.state_unchanged, true);
    const memoryId = (await new TaskService().create("planning", "Contract flow", { objective: "Inspect and plan" })).id;
    response = await call("memory", { action: "resolve", record_id: "M9", status: "confirmed", reason: "Guess" });
    assert.equal(response.code, "RECORD_NOT_FOUND");
    response = await call("memory", { action: "note", type: "observation", text: "Unverified observation" });
    assert.equal(response.data.record_status, "observed");
    response = await call("memory", { action: "resolve", record_id: response.data.record_id, status: "confirmed", reason: "Text alone" });
    assert.equal(response.code, "EVIDENCE_NOT_INSPECTED");
    const found = await call("context.find", { query: "calculateDuration", scope: "backend", sources: ["code"], limit: 3 });
    assert.equal(found.status, "ok"); const ref = found.data.results[0].ref as string;
    assert.equal((await call("context.inspect", { ref, view: "content" })).status, "ok");
    response = await call("memory", { action: "note", type: "evidence", body: "Wrong", tags: ["x"] });
    assert.equal(response.code, "INVALID_MEMORY_ACTION_PAYLOAD"); assert.match(response.message, /body.*text/); assert.equal(response.diagnostics.state_unchanged, true);
    response = await call("memory", { action: "note", type: "evidence", text: "Inspected implementation", evidence_refs: [ref] });
    assert.equal(response.data.record_id, "M2"); assert.equal(response.data.record_status, "supported");
    assert.equal(response.stage, "investigation");
    response = await call("memory", { action: "resolve", record_id: "M2", status: "confirmed", reason: "Direct inspection" });
    assert.equal(response.data.record_status, "confirmed");
    response = await call("memory", { action: "note", type: "decision", text: "Investigation supports complete requirements", evidence_refs: [ref] });
    response = await call("memory", { action: "resolve", record_id: response.data.record_id, status: "confirmed", reason: "Evidence is complete", evidence_refs: [ref] });
    assert.equal(response.stage, "specification"); assert.equal(response.required_skill, "code-intelligence-specification");
    response = await call("memory", { action: "spec_set", spec: { summary: "Wrong nesting", requirements: [] } });
    assert.equal(response.code, "INVALID_MEMORY_ACTION_PAYLOAD"); assert.match(response.message, /memory.spec_set/);
    assert.deepEqual(response.diagnostics.missing.sort(), ["requirements", "summary"]);
    assert.deepEqual(response.diagnostics.unexpected, ["spec"]);
    response = await call("memory", { action: "spec_set", summary: "Read-only preflight", requirements: [{ statement: "Investigate the implementation", kind: "constraint", priority: "must" }] });
    assert.equal(response.data.spec.requirements[0].id, "R1");
    assert.equal(response.stage, "planning"); assert.equal(response.required_skill, "code-intelligence-planning");
    response = await call("plan", { action: "new", steps: [] });
    assert.equal(response.code, "INVALID_INPUT"); assert.match(response.message, /create/);
    const baseStep = { kind: "investigation", title: "Inspect", objective: "Find evidence", covers: ["R1"], acceptance: ["Evidence identified"], verification: [{ kind: "custom", program: "node", args: ["--version"] }] };
    response = await call("plan", { action: "create", steps: [{ ...baseStep, requirementIds: ["R1"] }] });
    assert.equal(response.code, "INVALID_INPUT"); assert.match(response.message, /requirementIds.*covers/);
    response = await call("plan", { action: "create", steps: [{ ...baseStep, acceptance: [{ criterion: "Wrong" }] }] });
    assert.equal(response.code, "INVALID_INPUT"); assert.match(response.message, /acceptance\[0\]/);
    response = await call("plan", { action: "current" }); assert.equal(response.data.active, false);
    assert.equal(response.stage, "planning"); assert.equal(response.next_action, response.data.next_action);
    response = await call("plan", { action: "create", steps: [baseStep] });
    assert.equal(response.status, "ok"); assert.equal(response.data.step.kind, "investigation"); assert.deepEqual(response.data.step.covers, ["R1"]);
    assert.equal(response.stage, "implementation"); assert.equal(response.required_skill, "code-intelligence-implementation");
    assert.equal(response.data.guard_status, "unavailable");
    await writeFile(path.join(env.data, "guard-heartbeat.json"), JSON.stringify({ version: 2, integration: "opencode", workspace: "planning", at: new Date().toISOString() }));
    assert.equal((await call("plan", { action: "current" })).data.guard_status, "unavailable", "OpenCode heartbeat must not mark Qwen Code enforced");
    const opencode = await connectedClient("opencode");
    try { assert.equal((await opencode.call("plan", { action: "current" })).data.guard_status, "enforced"); }
    finally { await opencode.close(); }
    const current = await call("memory", { action: "current" });
    assert.equal(current.data.memory.id, memoryId);
    assert.equal(current.data.memory.findings_path, undefined);
    assert.equal(current.data.memory.spec_path, undefined);
    assert.equal((await call("plan", { action: "abandon", reason: "Preflight complete" })).code, "INVALID_INPUT");
    await new PlanService().transition("planning", "abandoned", "Preflight complete");
    response = await call("plan", { action: "create", steps: [{ ...baseStep, kind: "verification", title: "Verify" }] });
    assert.equal(response.status, "ok"); assert.equal(response.data.step.kind, "verification");
    await new PlanService().transition("planning", "abandoned", "Verification shape checked");
    await assert.rejects(new TaskService().complete("planning", memoryId, "Preflight completed"), /PLAN_REVIEW_REQUIRED/);
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});

test("MCP plan errors identify step, write, acceptance and verification without creating a plan", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-coverage-errors");
  const { call, close } = await connectedClient();
  try {
    await new TaskService().create("planning", "Coverage diagnostics");
    await call("memory", { action: "spec_set", summary: "Behavior", requirements: [{ statement: "Behavior works", kind: "behavior", priority: "must" }] });
    const step = { kind: "implementation", title: "Implement", objective: "Change behavior", covers: ["R1"],
      writes: [{ repo: "backend", path: "src/PlanningService.ts" }],
      acceptance: ["Behavior is correct"],
      verification: [{ kind: "test", program: "npm", args: ["test"], repo: "backend" }] };
    const invalid = [
      { input: { ...step, covers: [] }, path: "steps[0].covers", code: "INVALID_INPUT" },
      { input: { ...step, writes: [{ repo: "backend", path: "src/PlanningService.ts", covers: ["R1"] }] }, path: "steps[0].writes[0].covers", code: "INVALID_INPUT" },
      { input: { ...step, acceptance: [{ statement: "Behavior is correct" }] }, path: "steps[0].acceptance[0]", code: "INVALID_INPUT" },
      { input: { ...step, verification: [{ kind: "lint", program: "npm", args: ["test"], repo: "backend" }] }, path: "test verification", code: "COVERAGE_GAP" },
      { input: { ...step, verification: [{ kind: "test", program: "unknown", args: [] }] }, path: "not allowed", code: "INVALID_VERIFICATION" },
      { input: { ...step, verification: [{ kind: "test", command: "npm test && echo done" }] }, path: "verification[0]", code: "INVALID_INPUT" },
      { input: { ...step, verification: [{ kind: "test", command: "npm test && rm x" }] }, path: "verification[0]", code: "INVALID_INPUT" },
      { input: { ...step, verification: [{ kind: "test", program: "npm", args: ["test"] }, { kind: "test", program: "npm", args: ["test"] }] }, path: "duplicate verification", code: "INVALID_VERIFICATION" },
      { input: { ...step, verification: [{ kind: "test", program: "npm", args: ["test"], repo: "missing" }] }, path: "verification[0].repo", code: "INVALID_VERIFICATION" },
      { input: { ...step, verification: [{ kind: "test", program: "npm", args: ["test"], repo: "backend", cwd: "missing-dir" }] }, path: "verification[0].cwd", code: "INVALID_VERIFICATION" },
      { input: { ...step, acceptance: [{ statement: "Behavior is correct", covers: ["R1"], verified_by: [2] }] }, path: "acceptance[0]", code: "INVALID_INPUT" },
    ];
    for (const item of invalid) {
      const response = await call("plan", { action: "create", steps: [item.input] });
      assert.equal(response.code, item.code); assert.ok(response.message.includes(item.path), response.message);
      assert.equal((await call("plan", { action: "current" })).data.active, false);
    }
    const created = await call("plan", { action: "create", steps: [step] });
    assert.equal(created.status, "ok"); assert.equal(created.data.step.kind, "implementation");
    await new PlanService().transition("planning", "abandoned", "Contract checked");
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});
