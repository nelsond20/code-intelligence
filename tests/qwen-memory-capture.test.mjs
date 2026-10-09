import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instrumentQwenChunk, projectMemoryDeclaration } from "../scripts/qwen-memory-capture.mjs";

test("projects only the complete memory and plan declarations from the wire request", () => {
  const schema = { type: "object", properties: { requirements: { items: { properties: { kind: { enum: ["constraint"] } } } } } };
  const request = {
    messages: [{ role: "user", content: "private prompt" }],
    tools: [
      { type: "function", function: { name: "other", description: "other", parameters: { secret: "omit" } } },
      { type: "function", function: { name: "mcp__code-intelligence__memory", description: "complete description", parameters: schema } },
      { type: "function", function: { name: "mcp__code-intelligence__plan", description: "plan description", parameters: schema } },
    ],
  };
  assert.deepEqual(projectMemoryDeclaration(request), {
    tools: [{ name: "mcp__code-intelligence__memory", description: "complete description", parametersJsonSchema: schema },
      { name: "mcp__code-intelligence__plan", description: "plan description", parametersJsonSchema: schema }],
  });
  assert.deepEqual(projectMemoryDeclaration({ tools: [{ type: "function", name: "mcp__code-intelligence__memory", description: "complete description", parameters: schema }] }), {
    tools: [{ name: "mcp__code-intelligence__memory", description: "complete description", parametersJsonSchema: schema }],
  });
  assert.deepEqual(projectMemoryDeclaration({ tools: [] }), { tools: [] });
});

test("rejects incomplete or duplicate memory declarations", () => {
  const tool = { type: "function", function: { name: "mcp__code-intelligence__memory", description: "x", parameters: {} } };
  assert.throws(() => projectMemoryDeclaration({ tools: [{ ...tool, function: { ...tool.function, parameters: undefined } }] }), /lacks/);
  assert.throws(() => projectMemoryDeclaration({ tools: [tool, tool] }), /Duplicate/);
});

test("the Qwen 0.24.7 bundle has exactly one hook before its request is sent", () => {
  const root = new URL("../docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code/chunks/", import.meta.url);
  const files = {
    chat: "chunk-UZ5AMSVC.js",
    responses: "openaiResponsesContentGenerator-GK7IVKOS.js",
    headless: "chunk-2PBOCV6K.js",
    reminders: "chunk-UJ37RBHZ.js",
    core: "chunk-AN36BHDM.js",
  };
  const transformed = Object.fromEntries(Object.entries(files).map(([kind, file]) => [
    kind, instrumentQwenChunk(readFileSync(new URL(file, root), "utf8"), kind),
  ]));
  assert.ok(transformed.chat.includes("captureQwenOpenAIRequest(openaiRequest,userPromptId,\"chat_completions\");openaiRequestCaptureContext.getStore()?.(openaiRequest);"));
  assert.ok(transformed.responses.includes("captureQwenOpenAIRequest(activeRequest,userPromptId,\"responses\");"));
  assert.ok(transformed.headless.includes("markHeadlessUserTurn(currentPromptId,llmClient);const responseStream=llmClient.sendMessageStream("));
  assert.ok(transformed.core.includes("return runUserTurnModelRequest(prompt_id,this,()=>generator.generateContentStream(request,prompt_id))"));
  assert.ok(transformed.reminders.includes("const prelude=reminderParts.length===0?[]:[{role:\"user\",parts:reminderParts}];observeInitialDeferredReminder(toolRegistry,Boolean(deferredReminder),prelude.length===1);"));
  for (const [kind, source] of Object.entries(transformed)) {
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${kind}: ${syntax.stderr}`);
  }
});

test("skips preflight requests, then captures sanitized deferred evidence for the user turn", () => {
  const runtime = new URL("./.runtime/", import.meta.url);
  mkdirSync(runtime, { recursive: true });
  const output = path.join(fileURLToPath(runtime), `qwen-capture-${randomUUID()}.json`);
  try {
    const code = `import { captureQwenOpenAIRequest, markHeadlessUserTurn, runUserTurnModelRequest, observeInitialDeferredReminder } from ${JSON.stringify(new URL("../scripts/qwen-memory-capture.mjs", import.meta.url).href)};
      const memoryName = "mcp__code-intelligence__memory";
      const memory = { name: memoryName, description: "Brief description\\nFull nested guidance", shouldDefer: true };
      const registry = {
        getTool: name => name === memoryName ? memory : name === "tool_search" || name === "tool_call" ? { name } : undefined,
        getDeferredToolSummary: () => [{ name: memoryName, description: memory.description }],
        isEffectivelyDeferred: tool => tool.shouldDefer,
        isDeferredAndHidden: name => name === memoryName,
        isDeferredToolRevealed: () => false,
        isPermissionDeferred: () => false,
      };
      observeInitialDeferredReminder(registry, true, true);
      const client = { chat: {}, config: { getToolRegistry: () => registry }, announcedDeferredToolNames: new Set([memoryName]) };
      markHeadlessUserTurn("user-turn", client);
      captureQwenOpenAIRequest({ messages: [{ content: "private startup prompt" }] }, "startup", "chat_completions");
      captureQwenOpenAIRequest({ messages: [{ content: "private wrong request" }] }, "user-turn", "chat_completions");
      await runUserTurnModelRequest("user-turn", client.chat, async () => {
        await Promise.resolve();
        captureQwenOpenAIRequest({ messages: [{ content: "private user prompt" }], headers: { authorization: "private credential" }, tools: [] }, "user-turn", "chat_completions");
      });
      throw new Error("request was not stopped");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, QWEN_MEMORY_CAPTURE_FILE: output },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(output, "utf8");
    assert.ok(!raw.includes("private"));
    const resultJson = JSON.parse(raw);
    assert.deepEqual(resultJson.tools, []);
    assert.equal(resultJson.capture.phase, "first_headless_user_turn_model_request");
    assert.equal(resultJson.capture.openai_request_sequence, 3);
    assert.equal(resultJson.capture.skipped_openai_requests, 2);
    assert.equal(resultJson.deferred_memory.classified_deferred, true);
    assert.equal(resultJson.deferred_memory.hidden_from_normal_tools, true);
    assert.equal(resultJson.deferred_memory.memory_in_normal_tools_array, false);
    assert.equal(resultJson.deferred_memory.name_in_initial_reminder, true);
    assert.equal(resultJson.deferred_memory.initial_reminder_inserted_into_history, true);
    assert.equal(resultJson.deferred_memory.abbreviated_description_in_initial_reminder, true);
    assert.equal(resultJson.deferred_memory.full_description_in_initial_reminder, false);
    assert.equal(resultJson.deferred_memory.schema_in_initial_reminder, false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    unlinkSync(output);
  }
});
