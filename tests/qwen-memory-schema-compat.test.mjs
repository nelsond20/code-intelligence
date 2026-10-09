import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instrumentQwenConverter, restoreMemorySpecSetConstraints } from "../scripts/qwen-memory-schema-compat.mjs";

test("the pinned Qwen converter has one scoped patch point", () => {
  const source = readFileSync("docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code/chunks/chunk-GKVFTPMJ.js", "utf8");
  const patched = instrumentQwenConverter(source);
  assert.equal(patched.split("parameters=restoreMemorySpecSetConstraints(func.name,sourceSchema,parameters);").length, 2);
  assert.throws(() => instrumentQwenConverter("changed bundle"), /converter hook changed/);
});

test("only memory regains the spec_set constraints Qwen relaxes", () => {
  const source = {
    type: "object", additionalProperties: false,
    properties: { summary: { type: "string", maxLength: 50000 }, requirements: { type: "array", items: {
      type: "object", additionalProperties: false, properties: { statement: { type: "string", maxLength: 10000 } },
    } } },
  };
  const converted = structuredClone(source);
  delete converted.additionalProperties;
  delete converted.properties.summary.maxLength;
  delete converted.properties.requirements.items.additionalProperties;
  delete converted.properties.requirements.items.properties.statement.maxLength;
  const restored = restoreMemorySpecSetConstraints("mcp__code-intelligence__memory", source, converted);
  assert.deepEqual(restored, source);
  assert.deepEqual(converted.properties.summary, { type: "string" });
  assert.equal(restoreMemorySpecSetConstraints("mcp__code-intelligence__plan", source, converted), converted);
  assert.throws(() => restoreMemorySpecSetConstraints("mcp__code-intelligence__memory", {}, converted), /schema or converter changed/);
});
