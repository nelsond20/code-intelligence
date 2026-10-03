import path from "node:path";
import { access } from "node:fs/promises";
import { loadConfig } from "./config/loader.js";
import { assertEndpointAllowed } from "./privacy/network-policy.js";
import { runProcess } from "./shared/process.js";
import { WorkspaceRegistry } from "./workspace/registry.js";
import { appPaths } from "./workspace/paths.js";
import { readTextIfExists } from "./shared/fs.js";
import { GraphifyAdapter } from "./graph/graphify-adapter.js";
import { SerenaAdapter } from "./symbols/serena-adapter.js";
import type { CodeIntelligenceConfig } from "./config/schema.js";
import { LocalMcpAdapter } from "./broker/local-mcp-adapter.js";
import { findOpenCodeConfig, legacyDirectMcpNames } from "./integrations/opencode.js";

export interface DoctorCheck { name: string; status: "ok" | "warning" | "error"; detail: string; }

export async function checkEmbeddingProvider(config: CodeIntelligenceConfig, fetcher: typeof fetch = fetch): Promise<DoctorCheck> {
  const provider = config.embeddings.provider;
  try {
    const endpoint = assertEndpointAllowed(config.embeddings.base_url, config.privacy.network_policy);
    const path = provider === "ollama" ? "/api/tags" : "/v1/models";
    const response = await fetcher(new URL(path, endpoint), { signal: AbortSignal.timeout(config.embeddings.timeout_ms) });
    if (provider === "ollama") {
      const payload = await response.json() as { models?: Array<{ name: string }> };
      const present = payload.models?.some((model) => model.name === config.embeddings.model || model.name.startsWith(`${config.embeddings.model}:`));
      return { name: "ollama", status: response.ok && present ? "ok" : "warning",
        detail: present ? `Model ${config.embeddings.model} available` : `Endpoint reachable; model ${config.embeddings.model} not listed` };
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const present = payload.data?.some((model) => model.id === config.embeddings.model);
    return { name: "llamacpp", status: response.ok && present ? "ok" : "warning",
      detail: present ? `Model ${config.embeddings.model} available` : `Endpoint reachable; model ${config.embeddings.model} not listed` };
  } catch (error) {
    return { name: provider, status: "warning", detail: `Optional semantic search unavailable: ${(error as Error).message}` };
  }
}

export async function doctor(fetcher: typeof fetch = fetch): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let config;
  try { config = await loadConfig(); checks.push({ name: "config", status: "ok", detail: "Configuration parsed and validated" }); }
  catch (error) { return [{ name: "config", status: "error", detail: (error as Error).message }]; }
  try { assertEndpointAllowed(config.embeddings.base_url, config.privacy.network_policy); checks.push({ name: "network-policy", status: "ok", detail: config.privacy.network_policy }); }
  catch (error) { checks.push({ name: "network-policy", status: "error", detail: (error as Error).message }); }
  checks.push({ name: "privacy", status: !config.privacy.telemetry && !config.privacy.analytics && !config.privacy.query_logging ? "ok" : "error",
    detail: "telemetry=false analytics=false query_logging=false" });
  for (const workspace of await new WorkspaceRegistry().list()) for (const repo of workspace.repositories) {
    try { await access(repo.path); checks.push({ name: `repo:${workspace.id}/${repo.id}`, status: "ok", detail: repo.path }); }
    catch { checks.push({ name: `repo:${workspace.id}/${repo.id}`, status: "error", detail: "Path is not readable" }); }
  }
  for (const command of ["git", "rg"]) {
    try { const result = await runProcess(command, ["--version"], { timeoutMs: 3_000 }); checks.push({ name: command, status: result.code === 0 ? "ok" : "warning", detail: result.stdout.split("\n")[0] || result.stderr }); }
    catch (error) { checks.push({ name: command, status: "warning", detail: (error as Error).message }); }
  }
  if (config.embeddings.enabled) {
    checks.push(await checkEmbeddingProvider(config, fetcher));
  }
  const graphify = new GraphifyAdapter(config.graphify.command, config.graphify.timeout_ms);
  const serena = new SerenaAdapter(config.serena.command, config.serena.timeout_ms);
  checks.push({ name: "graphify", status: !config.graphify.enabled || await graphify.available() ? "ok" : "warning", detail: config.graphify.enabled ? "enabled" : "disabled (optional)" });
  checks.push({ name: "serena", status: !config.serena.enabled || await serena.available() ? "ok" : "warning", detail: config.serena.enabled ? "enabled" : "disabled (optional)" });
  for (const [name, source, kind] of [["local-docs", config.local_docs, "docs"], ["vault-retrieval", config.vault, "vault"]] as const) {
    if (!source.enabled) { checks.push({ name, status: "ok", detail: "disabled (optional)" }); continue; }
    const adapter = new LocalMcpAdapter({ source: kind, transport: source.transport, command: source.command, url: source.url,
      tokenFile: "token_file" in source ? source.token_file : undefined, networkPolicy: config.privacy.network_policy,
      timeoutMs: source.timeout_ms, searchTool: source.search_tool, inspectTool: source.inspect_tool, fetcher });
    try { const result = await adapter.diagnose(); checks.push({ name, status: "ok", detail: `connected, tools discovered (${result.tools.length})` }); }
    catch (error) { checks.push({ name, status: "warning", detail: `configured local source unavailable: ${(error as Error).message}` }); }
  }
  const paths = appPaths();
  const openCodeConfigPath = await findOpenCodeConfig(paths.opencodeDir);
  const openCodeConfig = await readTextIfExists(openCodeConfigPath);
  if (openCodeConfig) {
    try {
      const legacy = legacyDirectMcpNames(openCodeConfig, openCodeConfigPath);
      if (legacy.length) checks.push({ name: "opencode-mcp", status: "warning",
        detail: `legacy direct registration still exposed (${legacy.join(", ")})` });
    } catch (error) {
      checks.push({ name: "opencode-mcp", status: "warning", detail: (error as Error).message });
    }
  }
  const agents = await readTextIfExists(path.join(paths.opencodeDir, "AGENTS.md"));
  const plugin = await readTextIfExists(path.join(paths.opencodeDir, "plugins", "code-intelligence.ts"));
  checks.push({ name: "opencode-agents", status: agents?.includes("CODE_INTELLIGENCE_BEGIN") ? "ok" : "warning", detail: agents ? "managed block check" : "not installed" });
  checks.push({ name: "opencode-plugin", status: plugin?.includes("CODE_INTELLIGENCE_MANAGED_PLUGIN") ? "ok" : "warning", detail: plugin ? "managed plugin check" : "not installed" });
  checks.push({ name: "query-logging", status: process.env.GRAPHIFY_QUERY_LOG_DISABLE === "1" || !config.graphify.enabled ? "ok" : "warning", detail: "Graphify child processes always force GRAPHIFY_QUERY_LOG_DISABLE=1" });
  return checks;
}
