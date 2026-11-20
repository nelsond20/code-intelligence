import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { configSchema, defaultConfig, type CodeIntelligenceConfig } from "./schema.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { assertEndpointAllowed } from "../privacy/network-policy.js";
import { appPaths } from "../workspace/paths.js";

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("Only string arrays are supported in TOML config");
    return parsed;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  throw new Error(`Unsupported TOML value: ${value}`);
}

function validarCamposV2(config: Record<string, unknown>): void {
  const verificar = (objeto: Record<string, unknown>, permitidos: string[], contexto: string) => {
    const desconocido = Object.keys(objeto).find((campo) => !permitidos.includes(campo));
    if (desconocido) throw new Error(`Unknown configuration field ${contexto}.${desconocido}`);
  };
  verificar(config, ["schema_version", "privacy", "embeddings", "graphify", "serena", "local_docs", "vault", "limits", "sources", "workspaces"], "config");
  for (const [nombre, permitidos] of Object.entries({
    privacy: ["network_policy", "store_raw_source", "telemetry", "analytics", "query_logging"],
    embeddings: ["enabled", "provider", "base_url", "model", "timeout_ms", "batch_max_texts", "batch_max_tokens_estimate"],
    graphify: ["enabled", "command", "timeout_ms"], serena: ["enabled", "command", "timeout_ms"],
    local_docs: ["enabled", "transport", "command", "url", "timeout_ms", "search_tool", "inspect_tool"],
    vault: ["enabled", "transport", "command", "url", "timeout_ms", "token_file", "search_tool", "inspect_tool"],
    limits: ["read_default_lines", "read_max_lines", "output_max_bytes"],
  })) if (config[nombre]) verificar(config[nombre] as Record<string, unknown>, permitidos, nombre);
  for (const [indice, workspace] of ((config.workspaces || []) as Array<Record<string, unknown>>).entries()) {
    verificar(workspace, ["id", "name", "repositories", "verification"], `workspaces[${indice}]`);
    for (const [repositorio, value] of ((workspace.repositories || []) as Array<Record<string, unknown>>).entries()) {
      verificar(value, ["id", "path"], `workspaces[${indice}].repositories[${repositorio}]`);
    }
  }
}

export function parseConfigToml(text: string): CodeIntelligenceConfig {
  const root: Record<string, unknown> = { workspaces: [], sources: [] };
  let section: Record<string, unknown> = root;
  let currentWorkspace: Record<string, unknown> | undefined;
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[workspaces]]") {
      currentWorkspace = { repositories: [] };
      (root.workspaces as unknown[]).push(currentWorkspace);
      section = currentWorkspace;
      continue;
    }
    if (line === "[[workspaces.repositories]]") {
      if (!currentWorkspace) throw new Error(`Repository before workspace on line ${index + 1}`);
      const repository: Record<string, unknown> = {};
      (currentWorkspace.repositories as unknown[]).push(repository);
      section = repository;
      continue;
    }
    if (line === "[[sources]]") {
      const fuente: Record<string, unknown> = {};
      (root.sources as unknown[]).push(fuente);
      section = fuente;
      currentWorkspace = undefined;
      continue;
    }
    const sectionMatch = line.match(/^\[([a-z_]+)]$/i);
    if (sectionMatch) {
      const name = sectionMatch[1]!;
      const value: Record<string, unknown> = {};
      root[name] = value;
      section = value;
      currentWorkspace = undefined;
      continue;
    }
    const assignment = line.match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (!assignment) throw new Error(`Invalid TOML syntax on line ${index + 1}`);
    section[assignment[1]!] = parseValue(assignment[2]!);
  }
  if (root.schema_version === 2) validarCamposV2(root);
  const config = configSchema.parse(root);
  assertEndpointAllowed(config.embeddings.base_url, config.privacy.network_policy);
  if (config.local_docs.enabled && config.local_docs.transport === "http") assertEndpointAllowed(config.local_docs.url, config.privacy.network_policy);
  if (config.vault.enabled && config.vault.transport === "http") assertEndpointAllowed(config.vault.url, config.privacy.network_policy);
  for (const fuente of config.sources) if (fuente.enabled && fuente.transport === "http") assertEndpointAllowed(fuente.url!, config.privacy.network_policy);
  return config;
}

function quoted(value: string): string { return JSON.stringify(value); }

export function serializeConfigToml(config: CodeIntelligenceConfig): string {
  const lines = [
    `schema_version = ${config.schema_version}`,
    "",
    "[privacy]",
    `network_policy = ${quoted(config.privacy.network_policy)}`,
    `store_raw_source = ${config.privacy.store_raw_source}`,
    `telemetry = false`,
    `analytics = false`,
    `query_logging = false`,
    "",
    "[embeddings]",
    `enabled = ${config.embeddings.enabled}`,
    `provider = ${quoted(config.embeddings.provider)}`,
    `base_url = ${quoted(config.embeddings.base_url)}`,
    `model = ${quoted(config.embeddings.model)}`,
    `timeout_ms = ${config.embeddings.timeout_ms}`,
    `batch_max_texts = ${config.embeddings.batch_max_texts}`,
    `batch_max_tokens_estimate = ${config.embeddings.batch_max_tokens_estimate}`,
    "",
    "[graphify]",
    `enabled = ${config.graphify.enabled}`,
    `command = ${quoted(config.graphify.command)}`,
    `timeout_ms = ${config.graphify.timeout_ms}`,
    "",
    "[serena]",
    `enabled = ${config.serena.enabled}`,
    `command = ${quoted(config.serena.command)}`,
    `timeout_ms = ${config.serena.timeout_ms}`,
    "",
    "[local_docs]",
    `enabled = ${config.local_docs.enabled}`,
    `transport = ${quoted(config.local_docs.transport)}`,
    `command = ${quoted(config.local_docs.command)}`,
    `url = ${quoted(config.local_docs.url)}`,
    `timeout_ms = ${config.local_docs.timeout_ms}`,
    `search_tool = ${quoted(config.local_docs.search_tool)}`,
    ...(config.local_docs.inspect_tool ? [`inspect_tool = ${quoted(config.local_docs.inspect_tool)}`] : []),
    "",
    "[vault]",
    `enabled = ${config.vault.enabled}`,
    `transport = ${quoted(config.vault.transport)}`,
    `command = ${quoted(config.vault.command)}`,
    `url = ${quoted(config.vault.url)}`,
    `timeout_ms = ${config.vault.timeout_ms}`,
    ...(config.vault.token_file ? [`token_file = ${quoted(config.vault.token_file)}`] : []),
    `search_tool = ${quoted(config.vault.search_tool)}`,
    `inspect_tool = ${quoted(config.vault.inspect_tool)}`,
    "",
    "[limits]",
    `read_default_lines = ${config.limits.read_default_lines}`,
    `read_max_lines = ${config.limits.read_max_lines}`,
    `output_max_bytes = ${config.limits.output_max_bytes}`,
  ];
  for (const workspace of config.workspaces) {
    lines.push("", "[[workspaces]]", `id = ${quoted(workspace.id)}`, `name = ${quoted(workspace.name)}`,
      `verification = ${JSON.stringify(workspace.verification)}`);
    for (const repository of workspace.repositories) {
      lines.push("", "[[workspaces.repositories]]", `id = ${quoted(repository.id)}`, `path = ${quoted(repository.path)}`);
    }
  }
  for (const fuente of config.sources) {
    lines.push("", "[[sources]]", `id = ${quoted(fuente.id)}`, `enabled = ${fuente.enabled}`,
      `transport = ${quoted(fuente.transport)}`,
      ...(fuente.command ? [`command = ${quoted(fuente.command)}`] : []),
      ...(fuente.args.length ? [`args = ${JSON.stringify(fuente.args)}`] : []),
      ...(fuente.url ? [`url = ${quoted(fuente.url)}`] : []),
      ...(fuente.token_file ? [`token_file = ${quoted(fuente.token_file)}`] : []),
      `timeout_ms = ${fuente.timeout_ms}`, `search_tool = ${quoted(fuente.search_tool)}`,
      `inspect_tool = ${quoted(fuente.inspect_tool)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function loadConfig(file = appPaths().configFile): Promise<CodeIntelligenceConfig> {
  const text = await readTextIfExists(file);
  if (text === undefined) return defaultConfig();
  return parseConfigToml(text);
}

export async function saveConfig(config: CodeIntelligenceConfig, file = appPaths().configFile): Promise<void> {
  if (config.schema_version === 2) validarCamposV2(config as unknown as Record<string, unknown>);
  const parsed = configSchema.parse(config);
  assertEndpointAllowed(parsed.embeddings.base_url, parsed.privacy.network_policy);
  if (parsed.local_docs.enabled && parsed.local_docs.transport === "http") assertEndpointAllowed(parsed.local_docs.url, parsed.privacy.network_policy);
  if (parsed.vault.enabled && parsed.vault.transport === "http") assertEndpointAllowed(parsed.vault.url, parsed.privacy.network_policy);
  for (const fuente of parsed.sources) if (fuente.enabled && fuente.transport === "http") assertEndpointAllowed(fuente.url!, parsed.privacy.network_policy);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, serializeConfigToml(parsed));
}
