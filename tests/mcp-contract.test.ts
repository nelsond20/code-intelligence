import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createMcpServer, publicInputSchema } from "../src/mcp/server.js";
import { memoryInput, parseMemoryAction, planInput } from "../src/mcp/schemas.js";
import { fixtureWorkspace, isolated } from "./helpers.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { saveConfig } from "../src/config/loader.js";
import { TaskService } from "../src/task-state/service.js";
import { PlanService } from "../src/plan/service.js";

test("plan.create resolves two registered Git repos from a non-Git parent and captures each baseline", async () => {
  const previousWorkspace = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const previousCwd = process.cwd();
  const env = await isolated("mcp-parent-multi-repo");
  const workspace = path.join(env.root, "workspace");
  const first = path.join(workspace, "project-v1");
  const second = path.join(workspace, "project-v2");
  const firstText = "export const a = 1;\n";
  const secondText = "export const b = 2;\n";
  let close: (() => Promise<void>) | undefined;
  try {
    for (const repo of [first, second]) {
      await mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(path.join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
    }
    await assert.rejects(access(path.join(workspace, ".git")), /ENOENT/);
    await writeFile(path.join(first, "src", "a.ts"), firstText);
    await writeFile(path.join(second, "src", "b.ts"), secondText);
    await symlink(second, path.join(first, "src", "escape"));
    // A duplicate-looking file must never become the baseline target.
    await mkdir(path.join(first, "project-v1", "src"), { recursive: true });
    await writeFile(path.join(first, "project-v1", "src", "a.ts"), "wrong target\n");
    const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
    await registry.add("planning", [first, second]);
    process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
    process.chdir(workspace);
    const client = await connectedClient(); close = client.close;
    await new TaskService().create("planning", "Multi repository plan");
    assert.equal((await client.call("memory", { action: "spec_set", summary: "Change both repositories", requirements: [
      { statement: "Both changes work", kind: "behavior", priority: "must" },
    ] })).status, "ok");
    for (const forbidden of ["project-v1/src/escape/src/b.ts", path.join(workspace, "outside.ts")]) {
      const rejected = await client.call("plan", { action: "create", steps: [
        { title: "Escape", objective: "Write outside repo", writes: [forbidden] },
      ] });
      assert.equal(rejected.code, "SECURITY_VIOLATION");
    }
    const created = await client.call("plan", { action: "create", steps: [
      { title: "Change a", objective: "Edit first repo", writes: ["project-v1/src/a.ts", path.join(first, "src", "a.ts")] },
      { title: "Change b", objective: "Edit second repo", writes: ["project-v2/src/b.ts", path.join(second, "src", "b.ts")] },
    ] });
    assert.equal(created.status, "ok", JSON.stringify(created));
    assert.deepEqual(created.data.step.writes, ["project-v1:src/a.ts"]);
    const current = await client.call("plan", { action: "current" });
    assert.deepEqual(current.data.step.writes, ["project-v1:src/a.ts"]);
    const persisted = (await new PlanService().state("planning")).plan!;
    assert.deepEqual(persisted.steps.map((step) => step.writes.map((write) => `${write.repo}:${write.path}`)),
      [["project-v1:src/a.ts"], ["project-v2:src/b.ts"]]);
    assert.deepEqual(persisted.repository_baseline?.map((item) => item.repo), ["project-v1", "project-v2"]);
    for (const [index, repo, target, content] of [[0, "project-v1", "src/a.ts", firstText], [1, "project-v2", "src/b.ts", secondText]] as const) {
      const expectedHash = crypto.createHash("sha256").update(content).digest("hex");
      const baselineFiles: Array<{ path: string; hash: string }> | undefined =
        persisted.repository_baseline?.find((item) => item.repo === repo)?.files;
      assert.equal(baselineFiles?.find((file) => file.path === target)?.hash, expectedHash);
      assert.equal(persisted.steps[index]!.plan_baseline?.[0]?.state.hash, expectedHash);
      assert.deepEqual(persisted.steps[index]!.plan_baseline?.map((item) => `${item.repo}:${item.path}`), [`${repo}:${target}`]);
    }
    assert.equal(persisted.steps[0]!.write_baseline?.[0]?.state.hash,
      crypto.createHash("sha256").update(firstText).digest("hex"));
    await writeFile(path.join(first, "src", "a.ts"), "export const a = 3;\n");
    assert.equal((await client.call("plan", { action: "complete_current" })).data.advanced, true);
    assert.deepEqual((await client.call("plan", { action: "current" })).data.step.writes, ["project-v2:src/b.ts"]);
    assert.equal((await new PlanService().state("planning")).plan!.steps[1]!.write_baseline?.[0]?.state.hash,
      crypto.createHash("sha256").update(secondText).digest("hex"));
    const config = await registry.config();
    config.workspaces[0]!.repositories[1]!.path = path.join(workspace, "missing-v2");
    await saveConfig(config, env.config);
    const failure = await client.call("plan", { action: "revise_current", reason: "Check unavailable repository", step: {
      title: "Change b", objective: "Edit second repo", writes: ["project-v2/src/b.ts"],
    } });
    assert.equal(failure.code, "PLAN_REPOSITORY_RESOLUTION_FAILED");
    assert.equal(failure.diagnostics.repo, "project-v2");
    assert.equal(failure.diagnostics.path, "src/b.ts");
    assert.equal(failure.diagnostics.retry_same_action, false);
    assert.match(failure.next_action, /server diagnostics/);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(env.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    process.chdir(previousCwd);
    if (close) await close();
    if (previousWorkspace === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previousWorkspace;
    await env.cleanup();
  }
});

test("plan.create reports a response failure after persistence without exposing host paths", async () => {
  const previousWorkspace = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await isolated("mcp-plan-create-diagnostics");
  const repo = path.join(env.root, "repo");
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  let close: (() => Promise<void>) | undefined;
  try {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await registry.add("planning", [repo]);
    process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
    const client = await connectedClient(); close = client.close;
    await new TaskService().create("planning", "Diagnose plan creation");
    await client.call("memory", { action: "spec_set", summary: "Create source", requirements: [
      { statement: "Source works", kind: "behavior", priority: "must" },
    ] });
    const request = { action: "create", steps: [{ title: "Write source", objective: "Create a source file", writes: ["src/a.ts"] }] };
    await writeFile(path.join(repo, "package.json"), "{invalid json\n");
    const after = await client.call("plan", request);
    assert.equal(after.code, "PLAN_CREATE_FAILED");
    assert.equal(after.diagnostics.phase, "read_created_plan");
    assert.equal(after.diagnostics.error_type, "SyntaxError");
    assert.equal(after.diagnostics.plan_may_exist, true);
    assert.equal(after.diagnostics.retry_same_action, false);
    assert.match(after.next_action, /plan\.current before any retry/);
    assert.equal((await new PlanService().state("planning")).plan?.status, "active");
    assert.ok(!JSON.stringify(after).includes(env.root));
  } finally {
    if (close) await close();
    if (previousWorkspace === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previousWorkspace;
    await env.cleanup();
  }
});

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
    assert.deepEqual(memoryInput.shape.action.options, ["current", "note", "resolve", "spec_set"]);
    for (const key of ["anyOf", "oneOf", "allOf", "if", "then"]) assert.equal((memory.inputSchema as Record<string, unknown>)[key], undefined);
    assert.deepEqual(memory.inputSchema.required, ["action"]);
    assert.equal(memory.inputSchema.additionalProperties, false);
    assert.deepEqual((plan.inputSchema.properties?.action as { enum: string[] }).enum, ["current", "create", "complete_current", "revise_current"]);
    const memoryRoot = memory.inputSchema.properties as Record<string, any>;
    assert.match(memoryRoot.action.description, /READ: current.*WRITE: note.*spec_set.*never reads records/);
    assert.match(memoryRoot.summary.description, /spec_set WRITE/);
    assert.match(memoryRoot.requirements.description, /complete desired list/);
    for (const field of ["section", "offset", "state_token", "item_id"]) assert.match(memoryRoot[field].description, /ONLY for current READ continuation/);
    assert.match(memoryRoot.evidence_refs.description, /M\* memory record IDs are not evidence refs/);
    assert.match(memory.description!, /spec_set.*NEVER reads records/);
    assert.match(memory.description!, /section, offset, state_token, and item_id ONLY with current/);
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
    assert.deepEqual(planRoot.steps.items.required, ["title", "objective"]);
    assert.equal(planRoot.steps.items.properties.writes.items.type, "string");
    assert.equal(planRoot.steps.items.properties.verification, undefined);
    assert.equal(plan.inputSchema.type, "object");
    assert.doesNotMatch(JSON.stringify(memory.inputSchema), /"workspace":/);
    assert.deepEqual(plan.inputSchema.required, ["action"]);
    assert.equal(plan.inputSchema.additionalProperties, false);
    for (const key of ["anyOf", "oneOf", "allOf"]) assert.equal((plan.inputSchema as Record<string, unknown>)[key], undefined);
    for (const field of ["section", "offset", "state_token", "item_id", "steps", "reason", "step"]) assert.ok(planRoot[field]);
    const planBranches = (publicInputSchema(planInput) as { anyOf: Array<{ properties: Record<string, any>; required: string[] }> }).anyOf;
    const create = planBranches.find((item) => item.properties.action.const === "create")!;
    assert.deepEqual(create.properties.steps.items.required, ["title", "objective"]);
    const validator = new AjvJsonSchemaValidator();
    const memoryCheck = validator.getValidator(memory.inputSchema);
    const planCheck = validator.getValidator(plan.inputSchema);
    const requirement = { statement: "preflightSentinel returns true only for ready", kind: "constraint", priority: "must" };
    const investigation = { title: "Inspect sentinel", objective: "Find evidence" };
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
    for (const invalid of [{}, { action: "invalid" }, { action: "create" }, { action: "current", steps: [investigation] },
      { action: "complete_current", reason: "Unexpected" }, { action: "revise_current", reason: "Missing step" }]) {
      assert.equal(planInput.safeParse(invalid).success, false);
    }
    assert.equal(memoryCheck({ action: "new", title: "Preflight" }).valid, false);
    for (const invalid of [{}, { action: "invalid" }, { action: "spec_set" }, { action: "spec_set", section: "records", offset: 0 },
      { action: "spec_set", summary: "x", requirements: [{ statement: "x", kind: "constraint", priority: "must" }], section: "records" },
      { action: "current", summary: "x" }]) assert.equal(parseMemoryActionSafe(invalid), false);
    assert.equal(memoryCheck({ action: "spec_set", title: "Wrong", requirements: [{ id: "req-001", type: "constraint", severity: "MUST", description: "Invented" }] }).valid, false);
    assert.equal(planCheck({ action: "create", title: "Wrong", steps: [{ id: "step-1", kind: "investigation", description: "Invented", writes: [] }] }).valid, false);
  } finally { await close(); }
});

function parseMemoryActionSafe(input: Record<string, unknown>): boolean {
  try { parseMemoryAction(input as Parameters<typeof parseMemoryAction>[0]); return true; } catch { return false; }
}

test("memory read/write and evidence ID mistakes have distinct actionable diagnostics", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("memory-contract-mistakes");
  const { call, close } = await connectedClient("qwen-code");
  try {
    await new TaskService().create("planning", "Memory contract mistakes");
    let response = await call("memory", { action: "spec_set", section: "records", offset: 0 });
    assert.equal(response.code, "INVALID_MEMORY_ACTION_PAYLOAD");
    assert.equal(response.isError, true);
    assert.match(response.message, /spec_set is a WRITE action.*section\/offset.*memory\.current READ/);
    assert.match(response.next_action, /Use memory\.current to read/);
    assert.deepEqual(response.diagnostics.missing.sort(), ["requirements", "summary"]);
    assert.deepEqual(response.diagnostics.unexpected.sort(), ["offset", "section"]);
    assert.equal(response.diagnostics.state_unchanged, true);
    response = await call("memory", { action: "note", type: "observation", text: "The relevant behavior is visible in the source" });
    assert.equal(response.status, "ok");
    const recordId = response.data.record_id as string;
    assert.match(recordId, /^M[1-9][0-9]*$/);
    assert.equal(response.data.record_id_kind, "memory_record");
    assert.equal(response.data.is_evidence_ref, false);
    response = await call("memory", { action: "note", type: "evidence", text: "Wrong namespace", evidence_refs: [recordId] });
    assert.equal(response.code, "INVALID_EVIDENCE_REF_KIND");
    assert.match(response.message, /memory record ID, not a context evidence reference/);
    assert.match(response.next_action, /context\.find.*context\.inspect/);
    assert.equal((await call("memory", { action: "current" })).data.memory.records.length, 1);
    response = await call("memory", { action: "resolve", record_id: recordId, status: "confirmed", reason: "Wrong namespace", evidence_refs: [recordId] });
    assert.equal(response.code, "INVALID_EVIDENCE_REF_KIND");
    const found = await call("context.find", { query: "calculateDuration", scope: "backend", sources: ["code"], limit: 3 });
    const ref = found.data.results[0].ref as string;
    response = await call("memory", { action: "note", type: "evidence", text: "Found but not inspected", evidence_refs: [ref] });
    assert.equal(response.code, "EVIDENCE_NOT_INSPECTED");
    assert.match(response.message, /has not been inspected/);
    assert.equal((await call("context.inspect", { ref, view: "content" })).status, "ok");
    response = await call("memory", { action: "note", type: "evidence", text: "Inspected source behavior", evidence_refs: [ref] });
    assert.equal(response.status, "ok");
    assert.equal(response.data.record_id_kind, "memory_record");
    response = await call("memory", { action: "spec_set", summary: "Plan the inspected behavior", requirements: [
      { statement: "The behavior is implemented", kind: "behavior", priority: "must" },
    ] });
    assert.equal(response.stage, "planning");
    response = await call("memory", { action: "note", type: "observation", text: "A durable finding after specification" });
    assert.equal(response.code, "ACTION_NOT_ALLOWED_IN_STAGE");
    assert.equal(response.isError, true);
    assert.equal(response.stage, "planning");
    assert.equal(response.required_skill, "code-intelligence-planning");
    assert.equal(response.diagnostics.retry_same_action, false);
    assert.match(response.next_action, /Do not retry memory\.note.*plan\.create/);
    const current = await call("memory", { action: "current" });
    assert.equal(current.stage, "planning");
    assert.equal(current.required_skill, "code-intelligence-planning");
    assert.match(current.next_action, /plan\.create.*plan\.current/);
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});

test("planning rejects the repeated memory.note loop without creating M29 or changing stage", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("planning-note-loop");
  const { call, close } = await connectedClient();
  try {
    const tasks = new TaskService();
    const memory = await tasks.create("planning", "Loop fixture");
    const investigationNote = await call("memory", { action: "note", type: "observation", text: "Observed behavior" });
    assert.equal(investigationNote.status, "ok");
    assert.equal(investigationNote.stage, "investigation");
    assert.equal(investigationNote.data.record_id, "M1");
    const state = await tasks.read("planning", memory.id);
    state.next_record_id = 29;
    await tasks.storage.write("planning", state);
    const spec = await call("memory", { action: "spec_set", summary: "Implement observed behavior", requirements: [
      { statement: "Observed behavior works", kind: "behavior", priority: "must" },
    ] });
    assert.equal(spec.stage, "planning");
    const statePath = tasks.storage.statePath("planning", memory.id);
    const before = await readFile(statePath, "utf8");
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const rejected = await call("memory", { action: "note", type: "observation", text: "Investigando archivos frontend con context_find" });
      assert.equal(rejected.code, "ACTION_NOT_ALLOWED_IN_STAGE");
      assert.equal(rejected.isError, true);
      assert.equal(rejected.message, "memory.note is not allowed while stage=planning.");
      assert.equal(rejected.stage, "planning");
      assert.equal(rejected.required_skill, "code-intelligence-planning");
      assert.equal(rejected.diagnostics.retry_same_action, false);
      assert.equal(rejected.diagnostics.state_unchanged, true);
      assert.match(rejected.next_action, /Do not retry memory\.note.*plan\.create/);
      assert.equal(await readFile(statePath, "utf8"), before);
    }
    for (const request of [
      { action: "resolve", record_id: "M1", status: "confirmed", reason: "Planning lookup" },
      { action: "spec_set", summary: "Changed", requirements: [{ statement: "Changed", kind: "behavior", priority: "must" }] },
    ]) {
      const rejected = await call("memory", request);
      assert.equal(rejected.code, "ACTION_NOT_ALLOWED_IN_STAGE");
      assert.equal(rejected.diagnostics.retry_same_action, false);
      assert.equal(await readFile(statePath, "utf8"), before);
    }
    const current = await call("memory", { action: "current" });
    assert.equal(current.status, "ok");
    assert.equal(current.stage, "planning");
    assert.deepEqual(current.data.memory.records.map((record: { id: string }) => record.id), ["M1"]);
    const forged = await call("memory", { action: "note", type: "observation", text: "Forgery", stage: "investigation" });
    assert.equal(forged.code, "INVALID_MEMORY_ACTION_PAYLOAD");
    assert.equal(await readFile(statePath, "utf8"), before);
    const lookup = await call("context.find", { query: "calculateDuration", scope: "backend", sources: ["code"], limit: 1 });
    assert.equal(lookup.status, "ok", "bounded planning lookup remains available");
    assert.equal((await call("memory", { action: "current" })).stage, "planning");
    const plan = await call("plan", { action: "create", steps: [{ title: "Implement", objective: "Implement observed behavior" }] });
    assert.equal(plan.status, "ok");
    assert.equal(plan.stage, "implementation");
    const implementationNote = await call("memory", { action: "note", type: "observation", text: "Progress" });
    assert.equal(implementationNote.code, "ACTION_NOT_ALLOWED_IN_STAGE");
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});

test("MCP plan.current normalizes a model-supplied repository prefix before persistence", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await isolated("mcp-project-v1-write");
  const repo = path.join(env.root, "project-v1");
  await mkdir(repo, { recursive: true });
  const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  await registry.add("planning", [repo]);
  process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
  const { call, close } = await connectedClient();
  try {
    await new TaskService().create("planning", "Model write normalization");
    const spec = await call("memory", { action: "spec_set", summary: "Create indicator interface", requirements: [
      { statement: "The indicator interface exists", kind: "behavior", priority: "must" },
    ] });
    assert.equal(spec.stage, "planning");
    const modelPath = "project-v1/src/app/interfaces/indicadores/interface.ts";
    const canonicalPath = "src/app/interfaces/indicadores/interface.ts";
    const created = await call("plan", { action: "create", steps: [{ title: "Add interface", objective: "Create indicator interface", writes: [modelPath] }] });
    assert.equal(created.status, "ok");
    assert.deepEqual(created.data.step.writes, [canonicalPath]);
    const current = await call("plan", { action: "current" });
    assert.equal(current.status, "ok");
    assert.deepEqual(current.data.step.writes, [canonicalPath]);
    assert.doesNotMatch(JSON.stringify(current.data.step), /project-v1\/src\/app/);
    const persisted = (await new PlanService().state("planning")).plan!;
    assert.deepEqual(persisted.steps[0]!.writes.map(({ repo: id, path: target }) => ({ repo: id, path: target })),
      [{ repo: "project-v1", path: canonicalPath }]);
    assert.deepEqual(persisted.steps[0]!.write_baseline?.map(({ repo: id, path: target }) => ({ repo: id, path: target })),
      [{ repo: "project-v1", path: canonicalPath }]);
    assert.deepEqual(persisted.steps[0]!.plan_baseline?.map(({ repo: id, path: target }) => ({ repo: id, path: target })),
      [{ repo: "project-v1", path: canonicalPath }]);
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
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
    const baseStep = { title: "Inspect", objective: "Find evidence" };
    response = await call("plan", { action: "create", steps: [{ ...baseStep, requirementIds: ["R1"] }] });
    assert.equal(response.code, "INVALID_INPUT"); assert.match(response.message, /requirementIds/);
    response = await call("plan", { action: "create", steps: [{ ...baseStep, acceptance: [{ criterion: "Wrong" }] }] });
    assert.equal(response.code, "INVALID_INPUT"); assert.match(response.message, /acceptance/);
    response = await call("plan", { action: "current" }); assert.equal(response.data.active, false);
    assert.equal(response.stage, "planning"); assert.equal(response.next_action, response.data.next_action);
    response = await call("plan", { action: "create", steps: [baseStep] });
    assert.equal(response.status, "ok"); assert.deepEqual(response.data.step.writes, []);
    assert.equal(response.stage, "implementation"); assert.equal(response.required_skill, "code-intelligence-implementation");
    assert.equal(response.data.guard_status, "unavailable");
    await writeFile(path.join(env.data, "guard-heartbeat.json"), JSON.stringify({ version: 2, integration: "opencode", workspace: "planning", at: new Date().toISOString() }));
    assert.equal((await call("plan", { action: "current" })).data.guard_status, "unavailable", "OpenCode heartbeat must not mark Qwen Code enforced");
    const opencode = await connectedClient("opencode");
    try { assert.equal((await opencode.call("plan", { action: "current" })).data.guard_status, "enforced"); }
    finally { await opencode.close(); }
    const current = await call("memory", { action: "current" });
    assert.equal(current.data.memory.id, undefined);
    assert.equal(current.data.memory.findings_path, undefined);
    assert.equal(current.data.memory.spec_path, undefined);
    assert.equal((await call("plan", { action: "abandon", reason: "Preflight complete" })).code, "INVALID_INPUT");
    await new PlanService().transition("planning", "abandoned", "Preflight complete");
    response = await call("plan", { action: "create", steps: [{ ...baseStep, title: "Verify" }] });
    assert.equal(response.status, "ok"); assert.deepEqual(response.data.step.writes, []);
    await new PlanService().transition("planning", "abandoned", "Verification shape checked");
    await assert.rejects(new TaskService().complete("planning", memoryId, "Preflight completed"), /PLAN_REVIEW_REQUIRED/);
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});

test("MCP plan accepts minimal steps and rejects obsolete DSL fields", async () => {
  const previous = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-coverage-errors");
  const { call, close } = await connectedClient();
  try {
    await new TaskService().create("planning", "Coverage diagnostics");
    await call("memory", { action: "spec_set", summary: "Behavior", requirements: [{ statement: "Behavior works", kind: "behavior", priority: "must" }] });
    const step = { title: "Inspect", objective: "Understand behavior" };
    for (const field of ["kind", "covers", "acceptance", "verification"]) {
      const response = await call("plan", { action: "create", steps: [{ ...step, [field]: "obsolete" }] });
      assert.equal(response.code, "INVALID_INPUT"); assert.ok(response.message.includes(field), response.message);
      assert.equal((await call("plan", { action: "current" })).data.active, false);
    }
    const created = await call("plan", { action: "create", steps: [step] });
    assert.equal(created.status, "ok"); assert.deepEqual(created.data.step.writes, []);
    await new PlanService().transition("planning", "abandoned", "Contract checked");
  } finally {
    await close();
    if (previous === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = previous;
    await env.cleanup();
  }
});
