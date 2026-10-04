import { readFile } from "node:fs/promises";
// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sanitizedChildEnv } from "../privacy/child-env.js";
import { assertEndpointAllowed } from "../privacy/network-policy.js";
import { truncateUtf8 } from "../shared/fs.js";
import { docsRef, parseContextRef, vaultRef } from "./refs.js";
import type { ContextBackend, ContextReference, FindRequest, InspectRequest } from "./types.js";

export interface LocalAdapterConfig {
  source: "docs" | "vault";
  transport: "stdio" | "http";
  command: string;
  url: string;
  tokenFile?: string;
  networkPolicy: "loopback-only" | "unrestricted";
  timeoutMs?: number;
  searchTool: string;
  inspectTool?: string;
  fetcher?: typeof fetch;
  docsCache?: DocsResultCache;
  vaultRefs?: VaultRefCache;
}

interface RetainedDocsResult {
  content: string;
  metadata: Record<string, string>;
  truncated: boolean;
}

export class DocsResultCache {
  private readonly entries = new Map<string, { value: RetainedDocsResult; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries = 128, private readonly maxBytes = 2 * 1024 * 1024) {}

  set(ref: string, value: RetainedDocsResult): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const previous = this.entries.get(ref);
    if (previous) { this.entries.delete(ref); this.bytes -= previous.bytes; }
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    this.entries.set(ref, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.entries.get(oldest)!; this.entries.delete(oldest); this.bytes -= removed.bytes;
    }
  }

  get(ref: string): RetainedDocsResult | undefined { return this.entries.get(ref)?.value; }
}

export class VaultRefCache {
  private readonly entries = new Map<string, { path: string; bytes: number }>();
  private bytes = 0;
  private nextIdentity = 1n;

  constructor(private readonly maxEntries = 256, private readonly maxBytes = 256 * 1024) {}

  create(path: string): string {
    const bytes = Buffer.byteLength(path, "utf8");
    if (this.maxEntries < 1 || bytes > this.maxBytes) throw new Error("Vault note path is too large to retain safely");
    const ref = vaultRef(this.nextIdentity.toString(36)); this.nextIdentity++;
    this.entries.set(ref, { path, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.entries.get(oldest)!; this.entries.delete(oldest); this.bytes -= removed.bytes;
    }
    return ref;
  }

  get(ref: string): string | undefined { return this.entries.get(ref)?.path; }
}

function textContent(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return (content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
}

function structuredOrJsonText(result: unknown, label: string): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured;
  const text = textContent(result);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned malformed JSON`); }
}

function vaultHits(result: unknown): Array<{ path: string; score: number }> {
  const payload = structuredOrJsonText(result, "Vault search");
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { hits?: unknown }).hits)) {
    throw new Error("Vault search returned a malformed response: expected { hits: [...] }");
  }
  return (payload as { hits: unknown[] }).hits.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Vault search returned a malformed hit at index ${index}`);
    const { path, score } = raw as { path?: unknown; score?: unknown };
    if (typeof path !== "string" || !path || typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`Vault search returned a malformed hit at index ${index}: expected path and score`);
    }
    return { path, score };
  });
}

function vaultNote(result: unknown, expectedPath: string): { path: string; content: string } {
  const payload = structuredOrJsonText(result, "Vault read_note");
  if (!payload || typeof payload !== "object") {
    throw new Error("Vault read_note returned a malformed response: expected path and content");
  }
  const { path, content } = payload as { path?: unknown; content?: unknown };
  if (typeof path !== "string" || path !== expectedPath) {
    throw new Error(`Vault read_note returned an incoherent path for ${expectedPath}`);
  }
  if (typeof content !== "string") throw new Error("Vault read_note returned malformed content: expected a string");
  return { path, content };
}

function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function redactText(value: string, secret?: string): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}

function redactValue(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redactText(key, secret), redactValue(item, secret)]));
  return value;
}

function safeError(error: unknown, secret?: string): Error {
  const message = error instanceof Error ? error.message : "Local MCP operation failed";
  return new Error(redactText(message, secret));
}

export class LocalMcpAdapter implements ContextBackend {
  readonly source: "docs" | "vault";
  private readonly docsCache: DocsResultCache;
  private readonly vaultRefs: VaultRefCache;
  constructor(private readonly options: LocalAdapterConfig) {
    this.source = options.source; this.docsCache = options.docsCache || new DocsResultCache();
    this.vaultRefs = options.vaultRefs || new VaultRefCache();
  }

  private timeout(cap?: number): number {
    const configured = this.options.timeoutMs ?? 7_000;
    return cap === undefined ? configured : Math.min(configured, cap);
  }

  private async token(): Promise<string | undefined> {
    if (!this.options.tokenFile) return undefined;
    const token = (await readFile(this.options.tokenFile, "utf8")).trim();
    if (!token) throw new Error(`${this.source} token file is empty`);
    return token;
  }

  private async transport() {
    if (this.options.transport === "http") {
      const endpoint = assertEndpointAllowed(this.options.url, this.options.networkPolicy);
      const token = await this.token();
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      return { token, transport: new StreamableHTTPClientTransport(endpoint, { requestInit: { headers }, fetch: this.options.fetcher }) };
    }
    const rawEnv = sanitizedChildEnv("serena");
    const env = Object.fromEntries(Object.entries(rawEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return { token: undefined, transport: new StdioClientTransport({ command: this.options.command, args: [], env }) };
  }

  private async session<T>(action: (client: Client, tools: string[], token?: string) => Promise<T>): Promise<T> {
    let token: string | undefined;
    const client = new Client({ name: "code-intelligence-broker", version: "0.2.0" });
    try {
      const created = await this.transport(); token = created.token;
      await deadline(client.connect(created.transport), this.timeout(3_000), `${this.source} connection`);
      const tools: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await deadline(client.listTools(cursor ? { cursor } : undefined), this.timeout(3_000), `${this.source} tool discovery`);
        tools.push(...page.tools.map((tool) => tool.name)); cursor = page.nextCursor;
      } while (cursor);
      const configured = [this.options.searchTool, this.options.inspectTool].filter((name): name is string => Boolean(name));
      const missing = configured.filter((name) => !tools.includes(name));
      if (missing.length) throw new Error(`${this.source} configured MCP tool${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}`);
      return await action(client, tools, token);
    } catch (error) {
      throw safeError(error, token);
    } finally {
      await deadline(client.close().catch(() => undefined), this.timeout(1_000), `${this.source} shutdown`).catch(() => undefined);
    }
  }

  async diagnose(): Promise<{ tools: string[] }> {
    return this.session(async (_client, tools) => ({ tools }));
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.session(async (client, _tools, token) => {
      const result = await deadline(client.callTool({ name: tool, arguments: args }), this.timeout(), `${this.source} retrieval`);
      return redactValue(result, token);
    });
  }

  async find(request: FindRequest): Promise<ContextReference[]> {
    const limit = Math.max(1, Math.min(20, request.limit || 8));
    const result = await this.call(this.options.searchTool, { query: request.query, limit });
    if (this.source === "vault") {
      return vaultHits(result).slice(0, limit).map((hit) => ({
        ref: this.vaultRefs.create(hit.path), source: "vault", title: hit.path, snippet: "", score: hit.score,
        reason: "vault local retrieval",
      }));
    }
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    const text = textContent(result); let parsed: unknown = structured;
    if (parsed === undefined) {
      try { parsed = JSON.parse(text); } catch { parsed = [{ id: request.query, title: `${this.source} result`, snippet: text }]; }
    }
    const rows = Array.isArray(parsed) ? parsed : ((parsed as { results?: unknown[] })?.results || []);
    return rows.slice(0, limit).map((raw, index) => {
      const row = raw as Record<string, unknown>;
      const field = (name: string, max = 1_000) => typeof row[name] === "string" ? (row[name] as string).slice(0, max) : "";
      const explicitIdentity = field("ref", 2_000) || field("id", 2_000) || field("path", 2_000) || field("uri", 2_000);
      if (this.source === "docs") {
        const metadata = { framework: field("framework", 200), version: field("version", 200), source: field("source", 2_000),
          heading: field("heading", 1_000), commit: field("commit", 200) };
        const fullContent = field("content", 1_000_000) || field("text", 1_000_000) || field("snippet", 1_000_000);
        const identity = explicitIdentity || fullContent || `${request.query}:${index}`;
        const ref = docsRef(metadata, identity);
        const retained = truncateUtf8(fullContent, 16_000);
        this.docsCache.set(ref, { content: retained.text, metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)), truncated: retained.truncated });
        return { ref, source: this.source, title: metadata.heading || field("title") || field("name") || metadata.source || identity,
          snippet: fullContent.slice(0, 1_000), score: Number(row.score || 1 / (index + 1)), reason: "docs local retrieval",
          metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)) };
      }
      throw new Error(`Unsupported local MCP source: ${this.source}`);
    });
  }

  async inspect(request: InspectRequest): Promise<unknown> {
    const parsed = parseContextRef(request.ref);
    if (parsed.source !== this.source || !parsed.identity) throw new Error(`Not a ${this.source} reference`);
    const view = request.view || "content";
    if (this.source === "docs") {
      if (view !== "content") throw new Error(`Docs does not support inspect view: ${view}`);
      const retained = this.docsCache.get(request.ref);
      if (!retained) throw new Error("Docs reference is no longer materialized; repeat context.find and inspect the new ref");
      return { source: this.source, ref: request.ref, view, content: retained.content, metadata: retained.metadata, truncated: retained.truncated };
    }
    if (!this.options.inspectTool) throw new Error(`${this.source} inspection is not configured`);
    const path = this.vaultRefs.get(request.ref);
    if (!path) throw new Error("Vault reference is expired or belongs to another process; repeat context.find and inspect the new ref");
    const result = await this.call(this.options.inspectTool, { path });
    const note = vaultNote(result, path);
    const bounded = truncateUtf8(note.content, 16_000);
    return { source: this.source, ref: request.ref, view, path: note.path, content: bounded.text, truncated: bounded.truncated };
  }
}
