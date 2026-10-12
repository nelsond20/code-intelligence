import { loadConfig } from "../config/loader.js";
import type { CodeIntelligenceConfig } from "../config/schema.js";
import { parseContextRef } from "./refs.js";
import type { ContextBackend, ContextReference, ContextSource, FindRequest, InspectRequest } from "./types.js";
import type { LocalAdapterConfig } from "./local-mcp-adapter.js";

export class ContextBroker {
  constructor(private readonly backends: ContextBackend[]) {}
  async find(request: FindRequest) {
    const limit = Math.max(1, Math.min(20, request.limit || 8));
    const gitRelevant = /\b(commit|history|historical|introduced|changed|change|when did|who changed|blame|regression|previous|before|after|diff|historial|histórico|introdujo|cambió|cambio|cuándo|quién|regresión|anterior|antes|después|diferencia)\b/i.test(request.query);
    const defaults = this.backends.map((backend) => backend.source).filter((source) => source !== "git" || gitRelevant);
    const requested = new Set<ContextSource>(request.sources?.length ? request.sources : defaults);
    const disponibles = new Set(this.backends.map((backend) => backend.source));
    const desconocidas = [...requested].filter((source) => !disponibles.has(source) && !["code", "git", "docs", "vault"].includes(source));
    if (desconocidas.length) throw new Error(`Unknown context source: ${desconocidas.join(", ")}. Available sources: ${[...disponibles].sort().join(", ")}`);
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
      .map(({ item }) => ({ ...item, snippet: item.snippet.slice(0, 1000), available_views: item.available_views || (item.source === "git" ? ["summary", "diff", "file", "impact", "blame"]
        : item.source === "code" ? ["content", "surrounding"] : ["content"]) }));
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

export function fuentesConfiguradas(config: CodeIntelligenceConfig): Array<{ name: string; options: LocalAdapterConfig; enabled: boolean }> {
  const policy = config.privacy.network_policy;
  return [
    { name: "local-docs", enabled: config.local_docs.enabled, options: { source: "docs", profile: "docs" as const,
      transport: config.local_docs.transport, command: config.local_docs.command, url: config.local_docs.url,
      networkPolicy: policy, timeoutMs: config.local_docs.timeout_ms, searchTool: config.local_docs.search_tool,
      inspectTool: config.local_docs.inspect_tool } },
    { name: "vault-retrieval", enabled: config.vault.enabled, options: { source: "vault", profile: "vault" as const,
      transport: config.vault.transport, command: config.vault.command, url: config.vault.url, tokenFile: config.vault.token_file,
      networkPolicy: policy, timeoutMs: config.vault.timeout_ms, searchTool: config.vault.search_tool,
      inspectTool: config.vault.inspect_tool } },
    ...config.sources.map((fuente) => ({ name: `source:${fuente.id}`, enabled: fuente.enabled,
      options: { source: fuente.id, profile: "normalized" as const, transport: fuente.transport,
        command: fuente.command || "", args: fuente.args, url: fuente.url || "", tokenFile: fuente.token_file,
        networkPolicy: policy, timeoutMs: fuente.timeout_ms, searchTool: fuente.search_tool,
        inspectTool: fuente.inspect_tool } })),
  ];
}

export async function configuredExternalBackends(): Promise<ContextBackend[]> {
  const configuradas = fuentesConfiguradas(await loadConfig()).filter((fuente) => fuente.enabled);
  if (!configuradas.length) return [];
  const { LocalMcpAdapter } = await import("./local-mcp-adapter.js");
  return configuradas.map((fuente) => new LocalMcpAdapter(fuente.options));
}
