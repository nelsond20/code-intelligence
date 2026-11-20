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
    const memory = result.find((item) => item.tool === "memory")!;
    assert.deepEqual(memory.tools_list.requirement_contract?.required, ["statement", "kind", "priority"]);
    assert.equal(memory.tools_list.requirement_contract?.id_optional, true);
    assert.deepEqual(memory.tools_list.requirement_contract?.field_enums, { kind: ["behavior", "constraint"], priority: ["must", "should"] });
    assert.deepEqual(memory.tools_list.requirement_contract?.missing_guidance, []);
    assert.equal(memory.initial_description_equals_tools_list, false);
    const projectedSchema = structuredClone(listed.find((tool) => tool.name === "memory")!.inputSchema) as Record<string, any>;
    delete projectedSchema.properties.requirements.items.properties.kind.enum;
    delete projectedSchema.properties.requirements.items.properties.priority.enum;
    delete projectedSchema.properties.requirements.items.properties.priority.description;
    const projected = parseInitialTools({ tools: [{ name: "mcp__code-intelligence__memory", parametersJsonSchema: projectedSchema }] });
    const projectedResult = compareToolSchemas(serverTools, searched, projected).find((item) => item.tool === "memory")!;
    assert.deepEqual(projectedResult.initial.missing_critical_fields, []);
    assert.deepEqual(projectedResult.initial.requirement_contract?.field_enums, { kind: [], priority: [] });
    assert.deepEqual(projectedResult.initial.requirement_contract?.missing_guidance, ["priority"]);
    const initialOnly = compareToolSchemas(serverTools, undefined, projected).find((item) => item.tool === "memory")!;
    assert.equal(initialOnly.tool_search_equals_tools_list, null);
    assert.equal(initialOnly.initial_equals_tools_list, false);
    assert.equal(compareToolSchemas(serverTools, undefined, projected).find((item) => item.tool === "plan")!.initial.observed, false);
    const planTool = listed.find((tool) => tool.name === "plan")!;
    const planSchema = structuredClone(planTool.inputSchema) as Record<string, any>;
    delete planSchema.$schema;
    const planInitial = parseInitialTools({ tools: [{ name: "mcp__code-intelligence__plan", description: planTool.description,
      parametersJsonSchema: planSchema }] });
    const planResult = compareToolSchemas(serverTools, undefined, planInitial).find((item) => item.tool === "plan")!;
    assert.equal(planResult.initial_equals_tools_list, false);
    assert.equal(planResult.initial_plan_contract_preserved, true);
    delete planSchema.properties.steps.items.properties.writes.items.type;
    assert.equal(compareToolSchemas(serverTools, undefined, planInitial).find((item) => item.tool === "plan")!.initial_plan_contract_preserved, false);
    assert.ok(compareToolSchemas(serverTools, searched).every((item) => item.initial.observed === false && item.initial_equals_tools_list === null));
    const normalized = structuredClone(listed.find((tool) => tool.name === "memory")!.inputSchema) as Record<string, any>;
    delete normalized.$schema;
    delete normalized.additionalProperties;
    delete normalized.properties.requirements.items.additionalProperties;
    delete normalized.properties.requirements.items.properties.statement.maxLength;
    delete normalized.properties.summary.maxLength;
    delete normalized.properties.evidence_refs.items.maxLength;
    delete normalized.properties.reason.maxLength;
    delete normalized.properties.text.maxLength;
    const normalizedInitial = parseInitialTools({ tools: [{ name: "mcp__code-intelligence__memory",
      description: listed.find((tool) => tool.name === "memory")!.description, parametersJsonSchema: normalized }] });
    const normalizedResult = compareToolSchemas(serverTools, undefined, normalizedInitial).find((item) => item.tool === "memory")!;
    assert.equal(normalizedResult.initial_spec_set_contract_preserved, false);
    assert.deepEqual(normalizedResult.initial_schema_differences?.filter((difference) => difference.category === "A")
      .map((difference) => difference.path), ["/additionalProperties", "/properties/requirements/items/additionalProperties",
        "/properties/requirements/items/properties/statement/maxLength", "/properties/summary/maxLength"]);
    normalized.additionalProperties = false;
    normalized.properties.requirements.items.additionalProperties = false;
    normalized.properties.requirements.items.properties.statement.maxLength = 10000;
    normalized.properties.summary.maxLength = 50000;
    const restoredResult = compareToolSchemas(serverTools, undefined, normalizedInitial).find((item) => item.tool === "memory")!;
    assert.equal(restoredResult.initial_spec_set_contract_preserved, true);
    assert.equal(restoredResult.initial_equals_tools_list, false);
    assert.equal(restoredResult.initial_schema_differences?.length, 4);
    assert.ok(restoredResult.initial_schema_differences?.every((difference) => difference.category === "B"));
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
