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
import { TaskStorage } from "./task-state/storage.js";
import { SemanticIndex } from "./search/semantic.js";
import { RepositoryAccessPolicy } from "./privacy/repository-access.js";
import { structuralParserForPath } from "./symbols/parser.js";

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
  const workspaces = await new WorkspaceRegistry().list();
  const taskStorage = new TaskStorage();
  for (const workspace of workspaces) {
    const listed = await taskStorage.listWithDiagnostics(workspace.id);
    checks.push({ name: `state:${workspace.id}`, status: listed.corrupt_entries.length ? "warning" : "ok",
      detail: listed.corrupt_entries.length ? `corrupt or legacy entries: ${listed.corrupt_entries.map((item) => item.id).join(", ")}` : `${listed.memories.length} schema-v2 memories readable` });
    for (const memory of listed.memories) {
      const transaction = await taskStorage.recoverTransaction(workspace.id, memory.id);
      if (transaction === "recovered") checks.push({ name: `transaction:${workspace.id}/${memory.id}`, status: "warning", detail: "A pending task transaction was rolled back; inspect the last operation" });
      const rawPlan = await taskStorage.readPlan(workspace.id, memory.id);
      if (rawPlan) try {
        const plan = JSON.parse(rawPlan) as { status?: string; memory_id?: string };
        if (plan.memory_id !== memory.id) checks.push({ name: `plan:${workspace.id}/${memory.id}`, status: "error", detail: "Plan memory identity mismatch" });
        else if (plan.status === "active" && memory.status !== "active") checks.push({ name: `plan:${workspace.id}/${memory.id}`, status: "error", detail: "Active plan is attached to a non-active memory" });
      } catch (error) { checks.push({ name: `plan:${workspace.id}/${memory.id}`, status: "error", detail: `Plan is corrupt: ${(error as Error).message}` }); }
    }
    for (const repo of workspace.repositories) {
      try {
        await access(repo.path); await RepositoryAccessPolicy.create(repo.path);
        checks.push({ name: `repo:${workspace.id}/${repo.id}`, status: "ok", detail: `${repo.path}; access policy loaded` });
        const indexStatus = await new SemanticIndex(config, undefined, fetcher, workspace.id).status(repo);
        checks.push({ name: `index:${workspace.id}/${repo.id}`, status: indexStatus === "fresh" || indexStatus === "missing" ? "ok" : "warning", detail: indexStatus });
      } catch { checks.push({ name: `repo:${workspace.id}/${repo.id}`, status: "error", detail: "Path, policy, or index is not readable" }); }
    }
  }
  const structuralBackend = structuralParserForPath("probe.ts");
  checks.push({ name: "symbol-backed-refs", status: structuralBackend === "ast-grep" ? "ok" : "warning",
    detail: structuralBackend === "ast-grep" ? "ast-grep enabled for JavaScript/TypeScript; local fallback enabled for other languages"
      : "ast-grep native binding unavailable; local fallback enabled" });
  checks.push({ name: "config-effects", status: config.limits.read_default_lines > 0 && config.privacy.store_raw_source === false ? "ok" : "error",
    detail: `read_default_lines=${config.limits.read_default_lines}; store_raw_source=${config.privacy.store_raw_source}` });
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
  const heartbeat = await readTextIfExists(path.join(paths.dataDir, "guard-heartbeat.json"));
  let heartbeatFresh = false;
  if (heartbeat) try { const value = JSON.parse(heartbeat) as { at?: string; version?: number; integration?: string }; heartbeatFresh = value.version === 2 && value.integration === "opencode" && Boolean(value.at) && Date.now() - Date.parse(value.at!) < 300_000; } catch { /* warning below */ }
  checks.push({ name: "opencode-guard", status: heartbeatFresh ? "ok" : "warning", detail: heartbeatFresh ? "functional heartbeat observed" : "no recent compatible guard heartbeat" });
  checks.push({ name: "query-logging", status: process.env.GRAPHIFY_QUERY_LOG_DISABLE === "1" || !config.graphify.enabled ? "ok" : "warning", detail: "Graphify child processes always force GRAPHIFY_QUERY_LOG_DISABLE=1" });
  return checks;
}
