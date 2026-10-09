import { loadConfig } from "../config/loader.js";
import { parseContextRef } from "./refs.js";
import type { ContextBackend, ContextReference, ContextSource, FindRequest, InspectRequest } from "./types.js";

export class ContextBroker {
  constructor(private readonly backends: ContextBackend[]) {}
  async find(request: FindRequest) {
    const limit = Math.max(1, Math.min(20, request.limit || 8));
    const gitRelevant = /\b(commit|history|historical|introduced|changed|change|when did|who changed|blame|regression|previous|before|after|diff|historial|histórico|introdujo|cambió|cambio|cuándo|quién|regresión|anterior|antes|después|diferencia)\b/i.test(request.query);
    const defaults = this.backends.map((backend) => backend.source).filter((source) => source !== "git" || gitRelevant);
    const requested = new Set<ContextSource>(request.sources?.length ? request.sources : defaults);
    const selected = this.backends.filter((backend) => requested.has(backend.source));
    const settled = await Promise.allSettled(selected.map((backend) => backend.find({ ...request, limit })));
    const failures: string[] = [...requested].filter((source) => !selected.some((backend) => backend.source === source)).map((source) => `${source}: not configured`);
    const fused = new Map<string, { item: ContextReference; rankScore: number }>();
    settled.forEach((result, backendIndex) => {
      const backend = selected[backendIndex]!;
      if (result.status === "rejected") { failures.push(`${backend.source}: ${result.reason instanceof Error ? result.reason.message : "unavailable"}`); return; }
      result.value.forEach((item, rank) => {
        const rankScore = 1 / (61 + rank); const existing = fused.get(item.ref);
        if (existing) existing.rankScore += rankScore;
        else fused.set(item.ref, { item, rankScore: rankScore + Math.min(0.1, Math.max(0, item.score) / 100) });
      });
    });
    const results = [...fused.values()].sort((a, b) => b.rankScore - a.rankScore || a.item.ref.localeCompare(b.item.ref)).slice(0, limit)
      .map(({ item }) => ({ ...item, snippet: item.snippet.slice(0, 1000), available_views: item.available_views || (item.source === "docs" ? ["content"]
        : item.source === "vault" ? ["content"] : item.source === "git" ? ["summary", "diff", "file", "impact", "blame"] : ["content", "surrounding"]) }));
    const suggested = [...new Set(results.flatMap((item) => {
      const metadata = item.metadata || {}; return [metadata.symbol, metadata.path].filter((value): value is string => typeof value === "string" && value.length > 0);
    }))].slice(0, 5);
    return { results, unavailable_sources: failures, diagnostics: failures.length ? { degraded_sources: failures } : {},
      suggested_queries: suggested, truncated: fused.size > limit };
  }
  async inspect(request: InspectRequest) {
    const parsed = parseContextRef(request.ref); const backend = this.backends.find((candidate) => candidate.source === parsed.source);
    if (!backend) throw new Error(`Source ${parsed.source} is not configured`);
    return backend.inspect(request);
  }
}

export async function configuredExternalBackends(): Promise<ContextBackend[]> {
  const config = await loadConfig(); const backends: ContextBackend[] = [];
  if (!config.local_docs.enabled && !config.vault.enabled) return backends;
  const { LocalMcpAdapter } = await import("./local-mcp-adapter.js");
  if (config.local_docs.enabled) backends.push(new LocalMcpAdapter({ source: "docs", transport: config.local_docs.transport,
    command: config.local_docs.command, url: config.local_docs.url, networkPolicy: config.privacy.network_policy,
    timeoutMs: config.local_docs.timeout_ms, searchTool: config.local_docs.search_tool, inspectTool: config.local_docs.inspect_tool }));
  if (config.vault.enabled) backends.push(new LocalMcpAdapter({ source: "vault", transport: config.vault.transport,
    command: config.vault.command, url: config.vault.url, tokenFile: config.vault.token_file, networkPolicy: config.privacy.network_policy,
    timeoutMs: config.vault.timeout_ms, searchTool: config.vault.search_tool, inspectTool: config.vault.inspect_tool }));
  return backends;
}
