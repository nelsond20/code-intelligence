import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_TOOL_NAMES, registerPublicTools } from "../src/mcp/tools.js";
import { ToolRuntime } from "../src/mcp/runtime.js";
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
  for (const option of memoryInput.options) {
    assert.equal(Object.hasOwn(option.shape, "workspace"), false);
    assert.equal(Object.hasOwn(option.shape, "current_focus"), false);
    assert.equal(Object.hasOwn(option.shape, "next_actions"), false);
  }
  for (const option of planInput.options) assert.equal(Object.hasOwn(option.shape, "workspace"), false);
  assert.deepEqual(planInput.options.map((option) => option.shape.action.value), ["create", "current", "complete", "revise", "suspend", "reactivate", "abandon"]);
  assert.deepEqual(planInput.options.map((option) => Object.keys(option.shape).sort()), [
    ["action", "exceptions", "steps"], ["action"], ["action"], ["action", "operations", "reason"],
    ["action", "reason"], ["action"], ["action", "reason"],
  ]);
});

test("MCP find and inspect use the configured workspace and record inspection there", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-configured-workspace");
  try {
    const runtime = new ToolRuntime();
    await runtime.memory({ action: "new", title: "Configured workspace" });
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

test("all public memory actions use the configured workspace", async () => {
  const original = process.env.CODE_INTELLIGENCE_WORKSPACE;
  const env = await fixtureWorkspace("mcp-task-workspace");
  try {
    const runtime = new ToolRuntime();
    const created = await runtime.memory({ action: "new", title: "MCP memory" }) as { id: string };
    assert.equal((await runtime.memory({ action: "current" }) as { memory: { id: string } }).memory.id, created.id);
    assert.equal((await runtime.memory({ action: "update", phase: "implementation" }) as { phase: string }).phase, "implementation");
    assert.equal((await runtime.memory({ action: "note", type: "observation", text: "Configured workspace note" }) as { saved: boolean }).saved, true);
    assert.equal((await runtime.memory({ action: "pause" }) as { status: string }).status, "paused");
    assert.equal((await runtime.memory({ action: "activate", id: created.id }) as { status: string }).status, "active");
    assert.equal((await runtime.memory({ action: "complete", summary: "MCP memory action coverage completed." }) as { status: string }).status, "completed");
    const listed = await runtime.memory({ action: "list" }) as { memories: Array<{ id: string }> };
    assert.ok(listed.memories.some((memory) => memory.id === created.id));
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
    await assert.rejects(new ToolRuntime().memory({ action: "list" }),
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
