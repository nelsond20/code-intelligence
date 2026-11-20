import test from "node:test";
import assert from "node:assert/strict";
import { fixtureWorkspace, fixture } from "./helpers.js";
import { loadConfig, saveConfig } from "../src/config/loader.js";
import { ToolRuntime } from "../src/mcp/runtime.js";

test("version 2 stdio source participates in the public runtime without broker changes", async () => {
  const env = await fixtureWorkspace("inserted-stdio-source");
  try {
    const config = await loadConfig(env.config);
    config.schema_version = 2;
    config.sources = [{ id: "manuales-equipo", enabled: true, transport: "stdio", command: process.execPath,
      args: [fixture("source-mcp.mjs")], timeout_ms: 7_000, search_tool: "search", inspect_tool: "inspect" }];
    await saveConfig(config, env.config);
    const runtime = new ToolRuntime();
    const found = await runtime.contextFind({ query: "auth", sources: ["manuales-equipo"] });
    assert.equal(found.results[0]?.ref, "ci-source://manuales-equipo/v1/stable-guide");
    const restarted = new ToolRuntime();
    const inspected = await restarted.contextInspect({ ref: found.results[0]!.ref }) as { content: string };
    assert.equal(inspected.content, "Content for stable-guide");
  } finally { await env.cleanup(); }
});
