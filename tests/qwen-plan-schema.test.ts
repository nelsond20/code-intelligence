import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createMcpServer, publicInputSchema } from "../src/mcp/server.js";
import { memoryInput, planInput } from "../src/mcp/schemas.js";
import { TaskService } from "../src/task-state/service.js";
import { fixtureWorkspace, projectRoot } from "./helpers.js";

const qwenConverter = pathToFileURL(path.join(projectRoot,
  "docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code/chunks/chunk-GKVFTPMJ.js")).href;
const createArgs = { action: "create", steps: [{ title: "Inspect", objective: "Find evidence" }] };

test("Qwen 0.24.7 converter preserves flat plan arguments and MCP receives them", async () => {
  const env = await fixtureWorkspace("qwen-plan-schema");
  const server = createMcpServer();
  const client = new Client({ name: "qwen-code", version: "0.24.7" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map((tool) => tool.name), ["context.find", "context.inspect", "memory", "plan"]);
    const memory = listed.find((tool) => tool.name === "memory")!;
    const plan = listed.find((tool) => tool.name === "plan")!;
    const { OpenAIContentConverter } = await import(qwenConverter) as { OpenAIContentConverter: {
      convertLlmToolsToOpenAI: (tools: unknown[], compliance?: string) => Promise<Array<{ function: { parameters: Record<string, any> } }>>;
      convertOpenAIResponseToLlm: (response: unknown, context: unknown) => { candidates: Array<{ content: { parts: Array<{ functionCall?: { args: unknown } }> } }> };
    } };
    const convert = async (schema: unknown, compliance?: string) => {
      const declarations = [{ functionDeclarations: [{ name: "mcp__code-intelligence__plan", description: plan.description,
        parametersJsonSchema: schema }] }];
      return (await OpenAIContentConverter.convertLlmToolsToOpenAI(declarations, compliance))[0]!.function.parameters;
    };
    // The old publication is the regression fixture: Qwen preserves its root union.
    const previous = await convert(publicInputSchema(planInput));
    assert.equal(previous.anyOf.length, 4);
    for (const compliance of [undefined, "openapi_30"]) {
      const converted = await convert(plan.inputSchema, compliance);
      assert.equal(converted.type, "object");
      assert.deepEqual(converted.required, ["action"]);
      assert.deepEqual(converted.properties.action.enum, ["current", "create", "complete_current", "revise_current"]);
      assert.equal(converted.anyOf, undefined);
      assert.deepEqual(converted.properties.steps.items.required, ["title", "objective"]);
      assert.equal(converted.properties.steps.items.properties.verification, undefined);
      assert.equal(converted.properties.step.properties.verification, undefined);
      const validate = new AjvJsonSchemaValidator().getValidator(converted);
      assert.equal(validate({ action: "current" }).valid, true);
      assert.equal(validate(createArgs).valid, true);
      assert.equal(validate({}).valid, false);
    }
    const memoryConverted = (await OpenAIContentConverter.convertLlmToolsToOpenAI([{ functionDeclarations: [
      { name: "mcp__code-intelligence__memory", description: memory.description, parametersJsonSchema: memory.inputSchema },
    ] }]))[0]!.function.parameters;
    assert.deepEqual(memory.inputSchema, publicInputSchema(memoryInput));
    assert.deepEqual(memoryConverted.properties.action.enum, ["current", "note", "resolve", "spec_set"]);
    assert.equal(memoryConverted.anyOf, undefined);
    assert.match(memoryConverted.properties.action.description, /READ: current.*WRITE: note.*spec_set.*never reads records/);
    assert.match(memoryConverted.properties.section.description, /ONLY for current READ continuation/);
    assert.match(memoryConverted.properties.offset.description, /ONLY for current READ continuation/);
    assert.match(memoryConverted.properties.summary.description, /spec_set WRITE/);
    assert.match(memoryConverted.properties.evidence_refs.description, /M\* memory record IDs are not evidence refs/);

    const qwenArgs = (args: Record<string, unknown>) => {
      const response = OpenAIContentConverter.convertOpenAIResponseToLlm({ choices: [{
        message: { content: null, tool_calls: [{ id: "call-1", function: {
          name: "mcp__code-intelligence__plan", arguments: JSON.stringify(args),
        } }] }, finish_reason: "tool_calls",
      }] }, {});
      const parsed = response.candidates[0]!.content.parts[0]!.functionCall?.args;
      assert.deepEqual(parsed, args);
      return parsed as Record<string, unknown>;
    };

    const task = new TaskService();
    await task.create("planning", "Schema transport");
    await task.setSpec("planning", { summary: "Inspect behavior", requirements: [
      { statement: "Inspect implementation", kind: "constraint", priority: "must" },
    ] });
    const call = async (args: Record<string, unknown>) => {
      const response = await client.callTool({ name: "plan", arguments: args }) as { content: Array<{ text: string }> };
      return JSON.parse(response.content[0]!.text) as Record<string, any>;
    };
    assert.equal((await call(qwenArgs({ action: "current" }))).status, "ok");
    assert.equal((await call(qwenArgs(createArgs))).status, "ok");
    assert.equal((await call({ action: "current" })).data.active, true);
    for (const invalid of [{}, { action: "invalid" }, { action: "create" }, { action: "current", steps: createArgs.steps }]) {
      assert.equal((await call(invalid)).code, "INVALID_INPUT");
    }
  } finally {
    await client.close(); await server.close(); await env.cleanup();
  }
});
