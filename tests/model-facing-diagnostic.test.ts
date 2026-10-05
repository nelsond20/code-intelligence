import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { compareToolSchemas, parseInitialTools, parseToolSearchExport } from "../scripts/model-facing-schema-diagnostic.js";
import { ensureModelFacingIgnore } from "../scripts/model-facing-eval.js";
import { walkSourceFiles } from "../src/search/files.js";
import { isolated } from "./helpers.js";

test("schema diagnostic distinguishes published, searched, and unobserved initial shapes without emitting descriptions", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "schema-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const listed = (await client.listTools()).tools.filter((tool) => tool.name === "memory" || tool.name === "plan");
    const exportText = listed.map((tool) => `<function>${JSON.stringify({ name: `mcp__code-intelligence__${tool.name}`, description: tool.description, parametersJsonSchema: tool.inputSchema })}</function>`).join("\n");
    const searched = parseToolSearchExport(exportText);
    const initial = parseInitialTools({ tools: listed.map((tool) => ({ type: "function", function: { name: `mcp__code-intelligence__${tool.name}`,
      description: "private description", parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } } })) });
    const serverTools = listed.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.inputSchema }));
    const result = compareToolSchemas(serverTools, searched, initial);
    assert.ok(result.every((item) => item.tool_search_equals_tools_list && item.tool_search_description_equals_tools_list));
    assert.ok(result.every((item) => item.initial_equals_tools_list === false && item.initial.missing_critical_fields.length > 0));
    assert.ok(result.every((item) => item.tools_list.missing_critical_fields.length === 0));
    assert.ok(compareToolSchemas(serverTools, searched).every((item) => item.initial.observed === false && item.initial_equals_tools_list === null));
    assert.doesNotMatch(JSON.stringify(result), /private description|Investigate bug|Observable condition/);
  } finally { await client.close(); await server.close(); }
});

test("model-facing preparation preserves ignores and excludes Qwen exports from Code", async () => {
  const env = await isolated("model-facing-export-isolation");
  try {
    const workspace = path.join(env.root, "workspace"); await mkdir(workspace);
    await writeFile(path.join(workspace, ".codeintelligenceignore"), "custom.txt\n.ci-runtime/\n");
    await writeFile(path.join(workspace, "sentinel.mjs"), "export const preflightSentinel = 1;\n");
    await writeFile(path.join(workspace, "qwen-code-export-example.md"), "preflightSentinel from transcript\n");
    await ensureModelFacingIgnore(workspace);
    const first = await readFile(path.join(workspace, ".codeintelligenceignore"), "utf8");
    assert.equal(first, "custom.txt\n.ci-runtime/\nqwen-code-export-*.md\n");
    await ensureModelFacingIgnore(workspace);
    assert.equal(await readFile(path.join(workspace, ".codeintelligenceignore"), "utf8"), first);
    assert.deepEqual(await walkSourceFiles(workspace), ["sentinel.mjs"]);
  } finally { await env.cleanup(); }
});
