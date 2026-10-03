import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import { parseConfigToml, serializeConfigToml } from "../src/config/loader.js";
import { SemanticIndex } from "../src/search/semantic.js";
import { checkEmbeddingProvider } from "../src/doctor.js";
import { estimateEmbeddingTokens, splitEmbeddingChunk } from "../src/search/embedding-inputs.js";

test("embedding timeout defaults to 60 seconds and round-trips through TOML", () => {
  const config = defaultConfig();
  assert.equal(config.embeddings.timeout_ms, 60_000);
  config.embeddings.timeout_ms = 12_345;
  const serialized = serializeConfigToml(config);
  assert.match(serialized, /timeout_ms = 12345/);
  const parsed = parseConfigToml(serialized);
  assert.equal(parsed.embeddings.timeout_ms, 12_345);
  assert.equal(parsed.embeddings.batch_max_texts, 32);
  assert.equal(parsed.embeddings.batch_max_tokens_estimate, 7_000);
});

test("external source timeouts have safe defaults and round-trip independently", () => {
  const config = defaultConfig();
  assert.deepEqual({ graphify: config.graphify.timeout_ms, serena: config.serena.timeout_ms,
    local_docs: config.local_docs.timeout_ms, vault: config.vault.timeout_ms },
  { graphify: 10_000, serena: 10_000, local_docs: 7_000, vault: 7_000 });
  config.graphify.timeout_ms = 11_111;
  config.serena.timeout_ms = 22_222;
  config.local_docs.timeout_ms = 33_333;
  config.vault.timeout_ms = 44_444;
  const parsed = parseConfigToml(serializeConfigToml(config));
  assert.equal(parsed.graphify.timeout_ms, 11_111);
  assert.equal(parsed.serena.timeout_ms, 22_222);
  assert.equal(parsed.local_docs.timeout_ms, 33_333);
  assert.equal(parsed.vault.timeout_ms, 44_444);
  assert.throws(() => parseConfigToml(serializeConfigToml(config).replace("timeout_ms = 44444", "timeout_ms = 99")), /greater than or equal to 100/);
});

test("semantic requests use the configured embedding timeout", async () => {
  const config = defaultConfig(); config.embeddings.timeout_ms = 100;
  let receivedSignal: AbortSignal | undefined;
  const fetcher = ((_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal || undefined;
    return new Promise<Response>((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("timeout signal was not used")), 1_000);
      receivedSignal?.addEventListener("abort", () => { clearTimeout(guard); reject(receivedSignal?.reason); }, { once: true });
    });
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(new SemanticIndex(config, undefined, fetcher).embedder()(["query"]));
  assert.ok(receivedSignal?.aborted);
  assert.ok(Date.now() - started < 1_000, "configured timeout should abort promptly");
});

test("ollama embedding request remains unchanged", async () => {
  const config = defaultConfig();
  let request: { url: string; method?: string; body?: unknown } | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ embeddings: [[1], [2]] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await new SemanticIndex(config, undefined, fetcher).embedder()(["one", "two"]), [[1], [2]]);
  assert.deepEqual(request, { url: "http://127.0.0.1:11434/api/embed", method: "POST",
    body: { model: "qwen3-embedding:4b", input: ["one", "two"] } });
});

function llamaCppConfig() {
  const config = defaultConfig();
  config.embeddings.provider = "llamacpp";
  config.embeddings.base_url = "http://127.0.0.1:11435";
  config.embeddings.model = "qwen3-embedding-4b";
  return config;
}

test("llamacpp sends 32 small texts in one request", async () => {
  const config = llamaCppConfig();
  const texts = Array.from({ length: 32 }, (_, index) => `text-${index}`);
  const calls: Array<{ url: string; body: { model: string; input: string[]; encoding_format: string } }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; encoding_format: string };
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [index] })) }), { status: 200 });
  }) as typeof fetch;

  const embeddings = await new SemanticIndex(config, undefined, fetcher).embedder()(texts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:11435/v1/embeddings");
  assert.deepEqual(calls[0]?.body, { model: "qwen3-embedding-4b", input: texts, encoding_format: "float" });
  assert.equal(embeddings.length, 32);
});

test("llamacpp splits batches by aggregate token estimate", async () => {
  const config = llamaCppConfig(); config.embeddings.batch_max_tokens_estimate = 100;
  const batchSizes: number[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    return new Response(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [index] })) }), { status: 200 });
  }) as typeof fetch;
  await new SemanticIndex(config, undefined, fetcher).embedder()(Array.from({ length: 4 }, () => "x".repeat(40)));
  assert.deepEqual(batchSizes, [2, 2]);
});

test("llamacpp rejects one oversized text before making a request", async () => {
  const config = llamaCppConfig(); config.embeddings.batch_max_tokens_estimate = 100;
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(); }) as typeof fetch;
  await assert.rejects(new SemanticIndex(config, undefined, fetcher).embedder()(["x".repeat(99)]),
    /input 0 is estimated at 101 tokens.*batch_max_tokens_estimate=100/);
  assert.equal(calls, 0);
});

test("oversized single lines split only at Unicode code-point boundaries", () => {
  const text = "á🙂 word ".repeat(40);
  const chunks = splitEmbeddingChunk({ start_line: 12, end_line: 12, text }, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  assert.ok(chunks.every((chunk) => chunk.start_line === 12 && chunk.end_line === 12));
  assert.ok(chunks.every((chunk) => estimateEmbeddingTokens(chunk.text) <= 100));
});

test("llamacpp preserves input ordering across split batches", async () => {
  const config = llamaCppConfig(); config.embeddings.batch_max_tokens_estimate = 100;
  const texts = Array.from({ length: 5 }, (_, index) => `${index}${"x".repeat(39)}`);
  const batchSizes: number[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    const data = body.input.map((text, index) => ({ index, embedding: [Number(text[0])] })).reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  const embeddings = await new SemanticIndex(config, undefined, fetcher).embedder()(texts);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.deepEqual(embeddings, [[0], [1], [2], [3], [4]]);
});

test("doctor uses the llamacpp models endpoint", async () => {
  const config = defaultConfig();
  config.embeddings.provider = "llamacpp";
  config.embeddings.base_url = "http://127.0.0.1:11435";
  config.embeddings.model = "qwen3-embedding-4b";
  let requested = "";
  const fetcher = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ data: [{ id: "qwen3-embedding-4b" }] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await checkEmbeddingProvider(config, fetcher), {
    name: "llamacpp", status: "ok", detail: "Model qwen3-embedding-4b available",
  });
  assert.equal(requested, "http://127.0.0.1:11435/v1/models");
});

test("HTTP MCP configuration round-trips and enforces loopback-only URLs", () => {
  const config = defaultConfig();
  config.local_docs.enabled = true; config.local_docs.transport = "http";
  config.local_docs.url = "http://127.0.0.1:8000/mcp"; config.local_docs.search_tool = "docs.search";
  config.vault.enabled = true; config.vault.transport = "http"; config.vault.url = "http://127.0.0.1:8123/mcp";
  config.vault.token_file = "/safe/path/vault-token";
  const serialized = serializeConfigToml(config);
  assert.match(serialized, /transport = "http"/);
  assert.match(serialized, /token_file = "\/safe\/path\/vault-token"/);
  assert.doesNotMatch(serialized, /Bearer/);
  assert.doesNotMatch(serialized.split("[vault]")[0] || "", /inspect_tool/);
  const parsed = parseConfigToml(serialized);
  assert.equal(parsed.local_docs.search_tool, "docs.search"); assert.equal(parsed.local_docs.inspect_tool, undefined);
  assert.equal(parsed.vault.token_file, "/safe/path/vault-token");
  assert.throws(() => parseConfigToml(serialized.replace("http://127.0.0.1:8000/mcp", "https://docs.example.com/mcp")), /not loopback/);
});

test("Local Docs accepts an explicitly configured inspect tool for backward-compatible configuration", () => {
  const config = defaultConfig(); config.local_docs.inspect_tool = "legacy.read";
  assert.equal(parseConfigToml(serializeConfigToml(config)).local_docs.inspect_tool, "legacy.read");
});
