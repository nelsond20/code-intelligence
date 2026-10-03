import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { DocsResultCache, LocalMcpAdapter, VaultRefCache, type LocalAdapterConfig } from "../src/broker/local-mcp-adapter.js";
import { ContextBroker } from "../src/broker/service.js";
import type { ContextBackend } from "../src/broker/types.js";
import { fixtureWorkspace, isolated } from "./helpers.js";
import { defaultConfig } from "../src/config/schema.js";
import { loadConfig, saveConfig } from "../src/config/loader.js";
import { doctor } from "../src/doctor.js";
import { ToolRuntime } from "../src/mcp/runtime.js";
import { vaultReadNoteResult, vaultSearchResult } from "./fixtures/vault-contract.js";

interface MockMcpOptions {
  tools: string[];
  token?: string;
  failTool?: string;
  leakTokenInResult?: boolean;
  vaultSearchResult?: unknown;
  vaultReadNoteResult?: unknown;
  retrievalDelayMs?: number;
}

function mockMcp(options: MockMcpOptions) {
  const methods: string[] = [];
  const authorizations: Array<string | null> = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    authorizations.push(authorization);
    if (options.token && authorization !== `Bearer ${options.token}`) return new Response("unauthorized", { status: 401 });
    const message = JSON.parse(String(init?.body)) as { id?: string | number; method?: string; params?: Record<string, unknown> };
    if (message.id === undefined) return new Response(null, { status: 202 });
    methods.push(message.method || "");
    const response = (result?: unknown, error?: { code: number; message: string }) => new Response(JSON.stringify({
      jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }),
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (message.method === "initialize") return response({ protocolVersion: String(message.params?.protocolVersion),
      capabilities: { tools: {} }, serverInfo: { name: "mock-local-mcp", version: "1.0.0" } });
    if (message.method === "tools/list") return response({ tools: options.tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
    if (message.method === "tools/call") {
      const params = message.params as { name: string; arguments: Record<string, unknown> };
      calls.push(params);
      if (options.retrievalDelayMs) await new Promise((resolve) => setTimeout(resolve, options.retrievalDelayMs));
      if (options.failTool === params.name) return response(undefined, { code: -32000, message: `server failed ${options.token || ""}` });
      if (params.name === "docs.search") {
        const query = String(params.arguments.query);
        return response({ content: [{ type: "text", text: JSON.stringify({ results: [{
          content: `Local Docs content for ${query}. ${"detail ".repeat(180)}END_OF_FULL_CHUNK`,
          score: 24.671873,
          framework: "angular",
          version: "15.2.10",
          source: `aio/content/guide/${query}.md`,
          heading: "Creating a component using the Angular CLI",
          commit: "035aee01089b9f9d4b5b6af66a74002e07723fba",
        }] }) }] });
      }
      if (params.name === "search") {
        const secret = options.leakTokenInResult ? options.token || "" : "";
        const payload = options.vaultSearchResult ?? { hits: [{ path: `guide/auth${secret}`, score: 0.9 }] };
        return response({ content: [{ type: "text", text: JSON.stringify(payload) }] });
      }
      const payload = options.vaultReadNoteResult ?? {
        path: String(params.arguments.path),
        content: `inspected ${String(params.arguments.path)} ${options.leakTokenInResult ? options.token || "" : ""}`,
      };
      return response({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    }
    return response(undefined, { code: -32601, message: "method not found" });
  }) as typeof fetch;
  return { fetcher, methods, authorizations, calls };
}

function adapter(source: "docs" | "vault", fetcher: typeof fetch, overrides: Partial<LocalAdapterConfig> = {}) {
  return new LocalMcpAdapter({ source, transport: "http", command: source === "docs" ? "local-docs" : "vault-retrieval",
    url: source === "docs" ? "http://127.0.0.1:8000/mcp" : "http://127.0.0.1:8123/mcp",
    networkPolicy: "loopback-only", searchTool: source === "docs" ? "docs.search" : "search",
    inspectTool: source === "vault" ? "read_note" : undefined, fetcher, ...overrides });
}

test("Local Docs discovers only docs.search and retains full results behind compact refs", async () => {
  const server = mockMcp({ tools: ["docs.search", "docs.health", "docs.sources"] });
  const docs = adapter("docs", server.fetcher);
  assert.deepEqual(await docs.diagnose(), { tools: ["docs.search", "docs.health", "docs.sources"] });
  const found = await docs.find({ query: "component", limit: 3 });
  assert.match(found[0]?.ref || "", /^docs:\/\/item\/[a-f0-9]{64}$/);
  assert.equal(found[0]?.title, "Creating a component using the Angular CLI");
  assert.equal(found[0]?.snippet.length, 1_000);
  assert.doesNotMatch(JSON.stringify(found[0]), /END_OF_FULL_CHUNK/);
  const inspected = await docs.inspect({ ref: found[0]!.ref }) as { content: string };
  assert.match(inspected.content, /^Local Docs content for component/);
  assert.match(inspected.content, /END_OF_FULL_CHUNK$/);
  assert.ok(inspected.content.length > found[0]!.snippet.length);
  assert.ok(server.methods.includes("initialize"));
  assert.ok(server.methods.includes("tools/list"));
  assert.deepEqual(server.calls.map((call) => call.name), ["docs.search"]);
  assert.deepEqual(server.calls[0]?.arguments, { query: "component", limit: 3 });
});

test("vault HTTP MCP reads bearer token at runtime and redacts it from results and errors", async () => {
  const env = await isolated("vault-http-token");
  try {
    const token = "vault-super-secret-token";
    const tokenFile = path.join(env.root, "vault-token"); await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    const server = mockMcp({ tools: ["search", "read_note"], token, leakTokenInResult: true });
    const vault = adapter("vault", server.fetcher, { tokenFile });
    const found = await vault.find({ query: "auth" });
    assert.ok(server.authorizations.length > 0);
    assert.ok(server.authorizations.every((header) => header === `Bearer ${token}`));
    assert.doesNotMatch(JSON.stringify(found), new RegExp(token));
    assert.match(found[0]?.title || "", /\[REDACTED\]/);

    const failingServer = mockMcp({ tools: ["search", "read_note"], token, failTool: "search" });
    const failingVault = adapter("vault", failingServer.fetcher, { tokenFile });
    await assert.rejects(failingVault.find({ query: "auth" }), (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(token)); assert.match(error.message, /\[REDACTED\]/); return true;
    });
  } finally { await env.cleanup(); }
});

test("HTTP MCP rejects non-loopback URLs and requires search but only validates inspect when configured", async () => {
  let fetches = 0;
  const fetcher = (async () => { fetches++; throw new Error("must not fetch"); }) as typeof fetch;
  await assert.rejects(adapter("docs", fetcher, { url: "https://docs.example.com/mcp" }).diagnose(), /not loopback/);
  assert.equal(fetches, 0);
  const server = mockMcp({ tools: ["different.search"] });
  await assert.rejects(adapter("docs", server.fetcher).diagnose(), /configured MCP tool not found: docs\.search/);
  const searchOnly = mockMcp({ tools: ["docs.search"] });
  assert.deepEqual(await adapter("docs", searchOnly.fetcher).diagnose(), { tools: ["docs.search"] });
  await assert.rejects(adapter("docs", searchOnly.fetcher, { inspectTool: "legacy.read" }).diagnose(), /legacy\.read/);
});

test("Local MCP retrieval uses the source-specific configured timeout", async () => {
  const server = mockMcp({ tools: ["search", "read_note"], retrievalDelayMs: 200 });
  const vault = adapter("vault", server.fetcher, { timeoutMs: 100 });
  await assert.rejects(vault.find({ query: "slow" }), /vault retrieval timed out/);
});

test("doctor accepts a Local Docs backend with only docs.search", async () => {
  const env = await isolated("doctor-http-mcp");
  try {
    const config = defaultConfig(); config.embeddings.enabled = false;
    config.local_docs.enabled = true; config.local_docs.transport = "http"; config.local_docs.search_tool = "docs.search";
    await saveConfig(config, env.config);
    const healthy = await doctor(mockMcp({ tools: ["docs.search"] }).fetcher);
    assert.deepEqual(healthy.find((check) => check.name === "local-docs"), {
      name: "local-docs", status: "ok", detail: "connected, tools discovered (1)",
    });
    const missing = await doctor(mockMcp({ tools: ["docs.sources"] }).fetcher);
    const check = missing.find((item) => item.name === "local-docs");
    assert.equal(check?.status, "warning"); assert.match(check?.detail || "", /docs\.search/);
  } finally { await env.cleanup(); }
});

test("broker fuses HTTP docs and vault refs and inspects them", async () => {
  const docsServer = mockMcp({ tools: ["docs.search"] });
  const vaultServer = mockMcp({ tools: ["search", "read_note"] });
  const broker = new ContextBroker([adapter("docs", docsServer.fetcher), adapter("vault", vaultServer.fetcher)]);
  const found = await broker.find({ query: "authentication", sources: ["docs", "vault"], limit: 8 });
  assert.deepEqual(new Set(found.results.map((result) => result.source)), new Set(["docs", "vault"]));
  const docsRef = found.results.find((result) => result.source === "docs")!.ref;
  const vaultRef = found.results.find((result) => result.source === "vault")!.ref;
  assert.match(docsRef, /^docs:\/\//); assert.match(vaultRef, /^v:[0-9a-z]+$/);
  assert.match(String((await broker.inspect({ ref: docsRef }) as { content: string }).content), /Local Docs content for authentication/);
  assert.match(String((await broker.inspect({ ref: vaultRef }) as { content: string }).content), /inspected guide\/auth/);
  assert.deepEqual(docsServer.calls.map((call) => call.name), ["docs.search"]);
  assert.deepEqual(vaultServer.calls.map((call) => call.name), ["search", "read_note"]);
  assert.deepEqual(vaultServer.calls[1]?.arguments, { path: "guide/auth" });
});

test("Vault uses the real hits/read_note contract, preserves scores, refs and broker limits", async () => {
  const server = mockMcp({ tools: ["search", "read_note"], vaultSearchResult,
    vaultReadNoteResult });
  const vault = adapter("vault", server.fetcher);
  const direct = await vault.find({ query: "actividad", limit: 1 });
  assert.deepEqual(direct, [{
    ref: "v:1", source: "vault", title: "progreso/actividad.md", snippet: "",
    score: 0.634, reason: "vault local retrieval",
  }]);
  assert.deepEqual(server.calls[0]?.arguments, { query: "actividad", limit: 1 });

  const broker = new ContextBroker([vault]);
  const found = await broker.find({ query: "actividad", sources: ["vault"], limit: 2 });
  assert.equal(found.results.length, 2);
  assert.deepEqual(found.results.map(({ ref, score }) => ({ ref, score })), [
    { ref: "v:2", score: 0.634 },
    { ref: "v:3", score: 0.629 },
  ]);
  assert.deepEqual(server.calls[1]?.arguments, { query: "actividad", limit: 2 });

  const inspected = await broker.inspect({ ref: found.results[1]!.ref, view: "content" }) as { path: string; content: string };
  assert.equal(inspected.path, vaultReadNoteResult.path);
  assert.equal(inspected.content, vaultReadNoteResult.content);
  assert.deepEqual(server.calls[2]?.arguments, { path: "repos/analitica.md" });
});

test("Vault refs stay opaque for Unicode and punctuation-heavy paths", async () => {
  const notePath = "área personal/Análisis — Q4 (final)! #1 [✓].md";
  const server = mockMcp({ tools: ["search", "read_note"],
    vaultSearchResult: { hits: [{ path: notePath, score: 0.812 }] },
    vaultReadNoteResult: { path: notePath, content: "contenido" } });
  const vault = adapter("vault", server.fetcher);
  const found = await vault.find({ query: "análisis", limit: 1 });
  assert.equal(found[0]?.ref, "v:1");
  assert.match(found[0]?.ref || "", /^v:[0-9a-z]+$/);
  assert.doesNotMatch(found[0]?.ref || "", /área|Análisis|%|\/|\.|#|!/);
  await vault.inspect({ ref: found[0]!.ref, view: "content" });
  assert.deepEqual(server.calls[1]?.arguments, { path: notePath });
});

test("Vault refs are bounded, process-local, and expire with a repeat-find instruction", async () => {
  const server = mockMcp({ tools: ["search", "read_note"] });
  const vault = adapter("vault", server.fetcher, { vaultRefs: new VaultRefCache(2, 1_000) });
  const first = (await vault.find({ query: "one" }))[0]!.ref;
  const second = (await vault.find({ query: "two" }))[0]!.ref;
  const third = (await vault.find({ query: "three" }))[0]!.ref;
  assert.deepEqual([first, second, third], ["v:1", "v:2", "v:3"]);
  await assert.rejects(vault.inspect({ ref: first, view: "content" }), /expired.*repeat context\.find/);
  await vault.inspect({ ref: second, view: "content" });

  const restarted = adapter("vault", server.fetcher);
  await assert.rejects(restarted.inspect({ ref: third, view: "content" }), /another process.*repeat context\.find/);
});

test("Vault accepts empty hits and degrades malformed search responses", async () => {
  const emptyServer = mockMcp({ tools: ["search", "read_note"], vaultSearchResult: { hits: [] } });
  const empty = await new ContextBroker([adapter("vault", emptyServer.fetcher)])
    .find({ query: "missing", sources: ["vault"], limit: 4 });
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.unavailable_sources, []);

  for (const malformed of [{}, { results: [] }, { hits: [{ path: "note.md" }] }, { hits: null }]) {
    const server = mockMcp({ tools: ["search", "read_note"], vaultSearchResult: malformed });
    const result = await new ContextBroker([adapter("vault", server.fetcher)])
      .find({ query: "broken", sources: ["vault"], limit: 4 });
    assert.deepEqual(result.results, []);
    assert.match(result.unavailable_sources.join("\n"), /vault: Vault search returned a malformed/);
  }
});

test("Vault rejects incoherent read_note paths and non-string content", async () => {
  const badPath = mockMcp({ tools: ["search", "read_note"], vaultReadNoteResult: { path: "other.md", content: "text" } });
  const badPathVault = adapter("vault", badPath.fetcher); const badPathRef = (await badPathVault.find({ query: "note" }))[0]!.ref;
  await assert.rejects(badPathVault.inspect({ ref: badPathRef, view: "content" }), /incoherent path/);
  const contentServer = mockMcp({ tools: ["search", "read_note"], vaultSearchResult: { hits: [{ path: "note.md", score: 1 }] },
    vaultReadNoteResult: { path: "note.md", content: 42 } });
  const badContentVault = adapter("vault", contentServer.fetcher); const badContentRef = (await badContentVault.find({ query: "note" }))[0]!.ref;
  await assert.rejects(badContentVault.inspect({ ref: badContentRef, view: "content" }), /expected a string/);
});

test("unknown and unsupported Docs inspections fail without MCP calls or fabricated content", async () => {
  const server = mockMcp({ tools: ["docs.search"] }); const docs = adapter("docs", server.fetcher);
  const found = await docs.find({ query: "component" }); const calls = server.calls.length;
  await assert.rejects(docs.inspect({ ref: "docs://item/missing", view: "content" }), /no longer materialized.*context\.find/);
  await assert.rejects(docs.inspect({ ref: found[0]!.ref, view: "relations" }), /does not support inspect view: relations/);
  assert.equal(server.calls.length, calls);
});

test("Docs result retention is bounded and evicts oldest refs deterministically", async () => {
  const server = mockMcp({ tools: ["docs.search"] });
  const docs = adapter("docs", server.fetcher, { docsCache: new DocsResultCache(2, 100_000) });
  const first = (await docs.find({ query: "one" }))[0]!.ref;
  const second = (await docs.find({ query: "two" }))[0]!.ref;
  const third = (await docs.find({ query: "three" }))[0]!.ref;
  await assert.rejects(docs.inspect({ ref: first }), /no longer materialized/);
  assert.match(String(((await docs.inspect({ ref: second })) as { content: string }).content), /for two/);
  assert.match(String(((await docs.inspect({ ref: third })) as { content: string }).content), /for three/);

  const byteBounded = adapter("docs", server.fetcher, { docsCache: new DocsResultCache(10, 2_000) });
  const byteFirst = (await byteBounded.find({ query: "byte-one" }))[0]!.ref;
  const byteSecond = (await byteBounded.find({ query: "byte-two" }))[0]!.ref;
  await assert.rejects(byteBounded.inspect({ ref: byteFirst }), /no longer materialized/);
  assert.match(String(((await byteBounded.inspect({ ref: byteSecond })) as { content: string }).content), /for byte-two/);
});

test("ToolRuntime preserves retained Docs results between public find and inspect calls", async () => {
  const env = await fixtureWorkspace("runtime-docs-cache"); const originalFetch = globalThis.fetch;
  try {
    const config = await loadConfig(env.config); config.local_docs.enabled = true; config.local_docs.transport = "http";
    config.local_docs.search_tool = "docs.search"; await saveConfig(config, env.config);
    const server = mockMcp({ tools: ["docs.search"] }); globalThis.fetch = server.fetcher;
    const runtime = new ToolRuntime();
    const found = await runtime.contextFind({ query: "runtime", sources: ["docs"] });
    const inspected = await runtime.contextInspect({ ref: found.results[0]!.ref, view: "content" }) as { content: string };
    assert.match(inspected.content, /Local Docs content for runtime/);
    assert.deepEqual(server.calls.map((call) => call.name), ["docs.search"]);
  } finally { globalThis.fetch = originalFetch; await env.cleanup(); }
});

test("unavailable HTTP MCP source does not break healthy broker sources", async () => {
  const healthy = (["code", "vault", "git"] as const).map((source): ContextBackend => ({ source, async find() {
    const ref = source === "code" ? "code://repo/file.ts#L=1-1" : source === "vault" ? "v:1" : "git://repo/commit/aabbcc";
    return [{ ref, source, title: source, snippet: "healthy", score: 1 }]; }, async inspect() { return {}; } }));
  const unavailable = adapter("docs", (async () => { throw new Error("offline"); }) as typeof fetch);
  const result = await new ContextBroker([...healthy, unavailable]).find({ query: "auth", sources: ["code", "docs", "vault", "git"] });
  assert.deepEqual(new Set(result.results.map((item) => item.source)), new Set(["code", "vault", "git"]));
  assert.match(result.unavailable_sources.join("\n"), /docs: offline/);
});
