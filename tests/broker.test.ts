import test from "node:test";
import assert from "node:assert/strict";
import type { ContextBackend } from "../src/broker/types.js";
import { ContextBroker } from "../src/broker/service.js";
import { CodeBackend } from "../src/broker/code-backend.js";
import { TaskService } from "../src/task-state/service.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { fixtureWorkspace } from "./helpers.js";
import path from "node:path";
import { ToolRuntime } from "../src/mcp/runtime.js";

function backend(source: "docs" | "vault", fail = false): ContextBackend {
  return { source,
    async find() { if (fail) throw new Error("offline"); return [{ ref: `${source}://item/example`, source, title: `${source} title`, snippet: `${source} snippet`, score: 1 }]; },
    async inspect(request) { return { ref: request.ref, content: `${source} content` }; },
  };
}

test("broker fuses sources and one failed backend does not fail retrieval", async () => {
  const broker = new ContextBroker([backend("docs"), backend("vault", true)]);
  const result = await broker.find({ query: "authentication", limit: 8 });
  assert.equal(result.results.length, 1); assert.equal(result.results[0]?.source, "docs");
  assert.match(result.unavailable_sources[0] || "", /vault/);
  assert.deepEqual(await broker.inspect({ ref: result.results[0]!.ref }), { ref: "docs://item/example", content: "docs content" });
});

test("code references round-trip through find and inspect and task state biases ranking", async () => {
  const env = await fixtureWorkspace("broker-code");
  try {
    const tasks = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
    await tasks.create("planning", "Planning duration");
    await tasks.note("planning", { type: "observation", text: "Backend duration is relevant", repo: "backend", file: "src/PlanningService.ts" });
    const code = new CodeBackend(env.registry, tasks, async () => "planning");
    const results = await code.find({ query: "Math.round duration", limit: 8 });
    assert.ok(results.length >= 2); assert.match(results[0]!.ref, /^code:\/\//); assert.equal(results[0]!.metadata?.repo, "backend");
    const inspected = await code.inspect({ ref: results[0]!.ref, view: "content" }) as { content: string };
    assert.match(inspected.content, /Math\.round/);
    assert.ok(results.some((item) => item.metadata?.repo === "shared"), "task hints must bias, not hard-filter other repositories");
  } finally { await env.cleanup(); }
});

test("broker bounds snippets and result count", async () => {
  const huge: ContextBackend = { source: "docs", async find() { return Array.from({ length: 50 }, (_, index) => ({ ref: `docs://item/${index}`, source: "docs" as const, title: String(index), snippet: "x".repeat(5000), score: 1 })); }, async inspect() { return {}; } };
  const result = await new ContextBroker([huge]).find({ query: "x", limit: 3 });
  assert.equal(result.results.length, 3); assert.ok(result.results.every((item) => item.snippet.length === 1000)); assert.equal(result.truncated, true);
});

test("context.inspect automatically records only mechanical inspection state", async () => {
  const env = await fixtureWorkspace("inspection-bookkeeping");
  try {
    const runtime = new ToolRuntime(); await runtime.memory({ action: "new", title: "Inspect planning" });
    const found = await runtime.contextFind({ query: "calculateDuration", sources: ["code"], limit: 2 });
    await runtime.contextInspect({ ref: found.results[0]!.ref, view: "content" });
    const current = await runtime.tasks.current("planning");
    assert.ok(current?.inspected_refs.includes(found.results[0]!.ref)); assert.ok(current?.relevant_files.length);
    assert.equal(current?.active_hypotheses.length, 0); assert.equal(current?.confirmed_findings.length, 0);
  } finally { await env.cleanup(); }
});
