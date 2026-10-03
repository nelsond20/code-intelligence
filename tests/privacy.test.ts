import test from "node:test";
import assert from "node:assert/strict";
import { assertEndpointAllowed } from "../src/privacy/network-policy.js";
import { sanitizedChildEnv } from "../src/privacy/child-env.js";
import { isGloballyIgnored } from "../src/privacy/ignores.js";
import { truncateUtf8 } from "../src/shared/fs.js";

test("loopback policy rejects remote endpoints", () => {
  assert.throws(() => assertEndpointAllowed("https://api.example.com", "loopback-only"), /not loopback/);
  assert.throws(() => assertEndpointAllowed("http://localhost:11434", "loopback-only"), /not loopback/);
  assert.equal(assertEndpointAllowed("http://127.0.0.1:11434", "loopback-only").hostname, "127.0.0.1");
  assert.equal(assertEndpointAllowed("http://[::1]:11434", "loopback-only").hostname, "[::1]");
});

test("child environment strips cloud credentials and forces privacy flags", () => {
  const env = sanitizedChildEnv("graphify", { PATH: "/bin", OPENAI_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", SAFE: "yes" });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GRAPHIFY_QUERY_LOG_DISABLE, "1"); assert.equal(env.SERENA_USAGE_REPORTING, "false"); assert.equal(env.SAFE, "yes");
});

test("secret and binary paths are ignored", () => {
  for (const file of [".env", ".env.local", "id_rsa", "credentials.json", "src/private.key", "node_modules/a.js", "image.png"]) assert.equal(isGloballyIgnored(file), true, file);
  assert.equal(isGloballyIgnored("src/service.ts"), false);
});

test("UTF-8 output bounding marks truncation", () => {
  const result = truncateUtf8("á".repeat(1000), 120); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.text) <= 140);
});
