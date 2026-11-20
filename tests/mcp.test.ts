import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_TOOL_NAMES, registerPublicTools } from "../src/mcp/tools.js";
import { ToolRuntime } from "../src/mcp/runtime.js";
import { formatToolResponse } from "../src/mcp/server.js";
import { contextFindInput, contextInspectInput, memoryInput, planInput } from "../src/mcp/schemas.js";
import { fixtureWorkspace } from "./helpers.js";
import { resolveWorkspaceId } from "../src/workspace/registry.js";

test("public MCP exposes exactly context, memory, and plan", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["context.find", "context.inspect", "memory", "plan"]);
  const registered: string[] = [];
  registerPublicTools((name) => { registered.push(name); }, new ToolRuntime());
  registered.sort();
  assert.deepEqual(registered, [...PUBLIC_TOOL_NAMES].sort());
  for (const internal of ["task", "git_inspect", "code_search", "code_read", "code_symbol", "code_relations", "task_current", "task_manage", "task_note", "shell", "edit"]) assert.equal(registered.includes(internal as never), false);
});

test("public MCP schemas never expose workspace selection", () => {
  assert.deepEqual(Object.keys(contextFindInput.shape).sort(), ["limit", "query", "scope", "sources"]);
  assert.deepEqual(Object.keys(contextInspectInput.shape).sort(), ["ref", "view"]);
  for (const field of ["workspace", "current_focus", "next_actions", "id", "title", "operations", "revision"]) assert.equal(Object.hasOwn(memoryInput.shape, field), false);
  assert.deepEqual(memoryInput.shape.action.options, ["current", "note", "resolve", "spec_set"]);
  for (const option of planInput.options) assert.equal(Object.hasOwn(option.shape, "workspace"), false);
  assert.deepEqual(planInput.options.map((option) => option.shape.action.value), ["current", "create", "complete_current", "revise_current"]);
  assert.deepEqual(planInput.options.map((option) => Object.keys(option.shape).sort()), [
    ["action", "item_id", "offset", "section", "state_token"], ["action", "steps"], ["action"], ["action", "reason", "step"],
  ]);
});

test("memory.current continuation survives the real runtime and MCP response envelope", async () => {
  const env = await fixtureWorkspace("mcp-large-current");
  try {
    const runtime = new ToolRuntime();
    const state = await runtime.tasks.create("planning", "Large memory");
    const now = new Date().toISOString();
    state.records = Array.from({ length: 400 }, (_, index) => ({ id: `M${index + 1}`, kind: "observation", text: `Observation ${index + 1} ${"x".repeat(70)}`,
      status: "observed", confidence: "medium", evidence_refs: [], created_at: now, updated_at: now }));
    state.next_record_id = 401; await runtime.tasks.storage.write("planning", state);
    await runtime.tasks.setSpec("planning", { summary: "Large spec", requirements: Array.from({ length: 400 }, (_, index) => ({
      statement: `Requirement ${index + 1} ${"y".repeat(70)}`, kind: "constraint", priority: "must" })) });
    const initial = runtime.memory({ action: "current" });
    const text = formatToolResponse(await initial).content[0]!.text;
    assert.ok(Buffer.byteLength(text) <= 24_000);
    const data = (JSON.parse(text) as { data: { memory: { id?: string; record_ids: string[]; spec: { requirement_ids: string[] } };
      continuation: { state_token: string } }; truncated?: boolean }).data;
    assert.equal(data.memory.id, undefined); assert.equal(data.memory.record_ids.length, 400);
    assert.equal(data.memory.spec.requirement_ids.length, 400);
    for (const section of ["records", "requirements"] as const) {
      let offset = 0; const ids: string[] = [];
      while (true) {
        const pageText = formatToolResponse(await runtime.memory({ action: "current", section, offset,
          state_token: data.continuation.state_token })).content[0]!.text;
        assert.ok(Buffer.byteLength(pageText) <= 24_000);
        const page = (JSON.parse(pageText) as { data: { items: Array<{ id: string }>; next_offset: number | null } }).data;
        ids.push(...page.items.map((item) => item.id));
        if (page.next_offset === null) break;
        offset = page.next_offset;
      }
      assert.equal(ids.length, 400);
      assert.equal(new Set(ids).size, 400);
    }
  } finally { await env.cleanup(); }
});

test("MCP find and inspect use the configured workspace and record inspection there", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-configured-workspace");
  try {
    const runtime = new ToolRuntime();
    await runtime.tasks.create("planning", "Configured workspace");
    const found = await runtime.contextFind({ query: "calculateDuration", scope: "backend", sources: ["code"], limit: 2 });
    assert.ok(found.results.length > 0);
    assert.ok(found.results.every((result) => result.metadata?.repo === "backend"));
    await runtime.contextInspect({ ref: found.results[0]!.ref, view: "content" });
    const current = await runtime.tasks.current("planning");
    assert.ok(current?.inspected_refs.includes(found.results[0]!.ref));
    assert.ok(current?.inspected_files.some((file) => file.repo === "backend"));
  } finally {
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
    await env.cleanup();
  }
});

test("public memory actions stay in the operator-selected workspace", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-task-workspace");
  try {
    const runtime = new ToolRuntime();
    const created = await runtime.tasks.create("planning", "MCP memory");
    assert.equal((await runtime.memory({ action: "current" }) as { memory: { title: string; id?: string } }).memory.id, undefined);
    assert.equal((await runtime.tasks.update("planning", created.id, { phase: "implementation" })).phase, "implementation");
    assert.equal((await runtime.memory({ action: "note", type: "observation", text: "Configured workspace note" }) as { saved: boolean }).saved, true);
    assert.equal((await runtime.tasks.transition("planning", "paused", created.id)).status, "paused");
    await assert.rejects(runtime.memory({ action: "current" }), /NO_ACTIVE_MEMORY/);
    assert.equal((await runtime.tasks.activate("planning", created.id)).status, "active");
    assert.equal((await runtime.tasks.complete("planning", created.id, "MCP memory action coverage completed.")).status, "completed");
    assert.ok((await runtime.tasks.list("planning")).some((memory) => memory.id === created.id));
  } finally {
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
    await env.cleanup();
  }
});

test("MCP fails clearly when CODE_INTELLIGENCE_WORKSPACE is missing or invalid", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-workspace-errors");
  try {
    delete process.env.CODE_INTELLIGENCE_WORKSPACE;
    await assert.rejects(new ToolRuntime().contextFind({ query: "anything", sources: ["docs"] }),
      /MCP is not configured: set CODE_INTELLIGENCE_WORKSPACE/);
    process.env.CODE_INTELLIGENCE_WORKSPACE = "missing";
    await assert.rejects(new ToolRuntime().memory({ action: "current" }),
      /MCP workspace is invalid: CODE_INTELLIGENCE_WORKSPACE=missing is not registered/);
  } finally {
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
    await env.cleanup();
  }
});

test("CLI workspace resolution still prefers an explicit workspace", () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  try {
    process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
    assert.equal(resolveWorkspaceId("history"), "history");
    assert.equal(resolveWorkspaceId(), "planning");
  } finally {
    if (original === undefined) delete process.env.CODE_INTELLIGENCE_WORKSPACE; else process.env.CODE_INTELLIGENCE_WORKSPACE = original;
  }
});
