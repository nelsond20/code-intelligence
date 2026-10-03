import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { applyOpenCodeIntegration, legacyDirectMcpNames, planOpenCodeIntegration } from "../src/integrations/opencode.js";
import { isolated } from "./helpers.js";

test("OpenCode installer preserves config shape, backs up, and is idempotent", async () => {
  const env = await isolated("installer");
  try {
    const installEnv = { ...process.env, CODE_INTELLIGENCE_WORKSPACE: "planning" };
    await mkdir(env.opencode, { recursive: true });
    const config = path.join(env.opencode, "opencode.jsonc");
    const agents = path.join(env.opencode, "AGENTS.md");
    await writeFile(config, `{// keep me\n  "provider": { "local": true },\n  "mcp": { "servers": {\n    "existing": { "enabled": true },\n    "local-docs": { "type": "remote", "url": "http://127.0.0.1:8000/mcp", "enabled": false }\n  } }\n}\n`);
    await writeFile(agents, "# Existing instructions\n\nKeep this spacing.\n\n");
    const plan = await planOpenCodeIntegration(false, installEnv); assert.equal(plan.changes.length, 3);
    assert.match(plan.summary, /WARNING opencode-mcp: legacy direct registration still exposed \(local-docs\)/);
    const backups = await applyOpenCodeIntegration(plan); assert.ok(backups.some((file) => file.startsWith(config)));
    const installed = await readFile(config, "utf8"); assert.match(installed, /"servers"/); assert.match(installed, /"existing"/); assert.match(installed, /"code-intelligence"/); assert.match(installed, /keep me/);
    assert.match(installed, /"local-docs"/, "install must report, but not silently remove, a legacy direct MCP");
    assert.match(installed, /"CODE_INTELLIGENCE_WORKSPACE": "planning"/);
    const plugin = await readFile(path.join(env.opencode, "plugins", "code-intelligence.ts"), "utf8");
    assert.doesNotMatch(plugin, /@opencode\/plugin/);
    assert.doesNotMatch(plugin, /Plugin\.define/);
    assert.match(plugin, /export default \{/);
    assert.match(plugin, /id: "code-intelligence"/);
    assert.match(plugin, /async setup\(ctx\)/);
    assert.match(plugin, /ctx\.session\.hook\("compaction"/);
    assert.match(plugin, /ctx\.location\.directory/);
    assert.match(plugin, /event\.system\.push\(\{\s*type: "text",\s*text:/);
    assert.doesNotMatch(plugin, /event\.system\.push\(\s*[`'"]/);
    assert.doesNotMatch(plugin, /event\.result\s*=/);
    assert.doesNotMatch(plugin, /experimental\.session\.compacting/);
    assert.match(plugin, /spawn\("code-intelligence", \["memory", "context", "--workspace", "planning", "--max-tokens", "3000"\]/);
    assert.match(plugin, /\["plan", action, "--workspace", "planning"\]/);
    assert.match(plugin, /ctx\.tool\.hook\("execute\.before"/);
    assert.match(plugin, /ctx\.tool\.hook\("execute\.after"/);
    assert.match(plugin, /\["edit", "write", "patch"\]/);
    assert.match(plugin, /kind: "shell"/);
    assert.match(plugin, /guard-before/);
    assert.match(plugin, /guard-after/);
    assert.match(plugin, /shell: false/);
    assert.match(plugin, /MAX_CONTEXT_BYTES = 12000/);
    assert.match(plugin, /remaining = MAX_CONTEXT_BYTES - capturedBytes/);
    assert.match(plugin, /TIMEOUT_MS = 3000/);
    assert.match(plugin, /\}, TIMEOUT_MS\)/);
    assert.match(plugin, /GRAPHIFY_QUERY_LOG_DISABLE: "1"/);
    assert.match(plugin, /SERENA_USAGE_REPORTING: "false"/);
    assert.match(plugin, /catch \{ \/\* fail open/);
    assert.match(plugin, /registration\.dispose\(\)/);
    const agentsAfterInstall = await readFile(agents, "utf8");
    assert.equal((await planOpenCodeIntegration(false, installEnv)).changes.length, 0);
    assert.equal(await readFile(agents, "utf8"), agentsAfterInstall, "a second plan must preserve AGENTS.md byte for byte");
    await writeFile(agents, `${agentsAfterInstall}\n`);
    assert.equal((await planOpenCodeIntegration(false, installEnv)).changes.length, 0, "existing whitespace outside an identical managed block must be preserved");
    assert.equal(await readFile(path.join(env.opencode, "plugins", "code-intelligence.ts"), "utf8"), plugin,
      "reinstalling must preserve the V2 plugin byte for byte");
    const removal = await planOpenCodeIntegration(true, installEnv); await applyOpenCodeIntegration(removal);
    assert.doesNotMatch(await readFile(config, "utf8"), /"code-intelligence"/);
  } finally { await env.cleanup(); }
});

test("OpenCode installer requires the MCP workspace as installation data", async () => {
  const env = await isolated("installer-workspace");
  try {
    const installEnv = { ...process.env }; delete installEnv.CODE_INTELLIGENCE_WORKSPACE;
    await assert.rejects(planOpenCodeIntegration(false, installEnv), /requires CODE_INTELLIGENCE_WORKSPACE/);
  } finally { await env.cleanup(); }
});

test("legacy OpenCode MCP detection handles current and legacy config shapes", () => {
  assert.deepEqual(legacyDirectMcpNames(`{ "mcp": { "servers": { "local-docs": {}, "code-intelligence": {} } } }`), ["local-docs"]);
  assert.deepEqual(legacyDirectMcpNames(`{ "mcp": { "obsidian-vault": {}, "other": {} } }`), ["obsidian-vault"]);
  assert.deepEqual(legacyDirectMcpNames(`{ "mcp": { "servers": { "code-intelligence": {} } } }`), []);
});
