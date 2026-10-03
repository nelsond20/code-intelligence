import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { appPaths, assertSafeId } from "../workspace/paths.js";
import { managedAgentsBlock, pluginSource } from "./templates.js";

const BEGIN = "<!-- CODE_INTELLIGENCE_BEGIN -->";
const END = "<!-- CODE_INTELLIGENCE_END -->";

function managedText(existing: string, block?: string): string {
  const start = existing.indexOf(BEGIN), end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error("AGENTS.md contains an incomplete Code Intelligence managed block; no changes made");
  }
  if (start >= 0) {
    const ownedEnd = end + END.length;
    if (block !== undefined) {
      if (existing.slice(start, ownedEnd) === block) return existing;
      return `${existing.slice(0, start)}${block}${existing.slice(ownedEnd)}`;
    }
    let before = existing.slice(0, start);
    const after = existing.slice(ownedEnd);
    if (before.endsWith("\n\n") && (after === "" || after === "\n")) before = before.slice(0, -1);
    return `${before}${after === "\n" ? "" : after}`;
  }
  if (block === undefined) return existing;
  if (!existing) return `${block}\n`;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}

function patchConfig(text: string, configFile: string, workspace: string | undefined, remove = false): string {
  const errors: ParseError[] = [];
  const value = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown>;
  if (errors.length) throw new Error(`OpenCode config has JSONC parse errors; no changes made (${configFile})`);
  const mcp = value.mcp as Record<string, unknown> | undefined;
  const nested = mcp && typeof mcp.servers === "object" && mcp.servers !== null;
  const target = nested ? ["mcp", "servers", "code-intelligence"] : ["mcp", "code-intelligence"];
  const entry = remove ? undefined : {
    type: "local", command: ["code-intelligence", "serve-mcp"], enabled: true,
    environment: { CODE_INTELLIGENCE_CONFIG: configFile, CODE_INTELLIGENCE_WORKSPACE: workspace,
      GRAPHIFY_QUERY_LOG_DISABLE: "1", SERENA_USAGE_REPORTING: "false" },
  };
  return applyEdits(text || "{}\n", modify(text || "{}\n", target, entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }, isArrayInsertion: false,
  }));
}

export function legacyDirectMcpNames(text: string, configFile = "OpenCode config"): string[] {
  const errors: ParseError[] = [];
  const value = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown>;
  if (errors.length) throw new Error(`OpenCode config has JSONC parse errors (${configFile})`);
  const mcp = value.mcp;
  if (!mcp || typeof mcp !== "object") return [];
  const direct = mcp as Record<string, unknown>;
  const entries = direct.servers && typeof direct.servers === "object"
    ? direct.servers as Record<string, unknown>
    : direct;
  return ["local-docs", "obsidian-vault", "vault-retrieval"].filter((name) => Object.hasOwn(entries, name));
}

export async function findOpenCodeConfig(opencodeDir: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json", "config.jsonc", "config.json"]) {
    if (await readTextIfExists(path.join(opencodeDir, name)) !== undefined) return path.join(opencodeDir, name);
  }
  return path.join(opencodeDir, "opencode.jsonc");
}

export interface IntegrationPlan { changes: Array<{ path: string; before: string; after: string }>; summary: string; }

function conciseDiff(change: { path: string; before: string; after: string }): string {
  const before = change.before.split(/\r?\n/), after = change.after.split(/\r?\n/);
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const removed = before.slice(prefix, before.length - suffix).slice(0, 40).map((line) => `-${line}`);
  const added = after.slice(prefix, after.length - suffix).slice(0, 40).map((line) => `+${line}`);
  const omitted = before.length - prefix - suffix > 40 || after.length - prefix - suffix > 40 ? ["… diff truncated"] : [];
  return [`--- ${change.path}`, `+++ ${change.path}`, ...removed, ...added, ...omitted].join("\n");
}

export async function planOpenCodeIntegration(remove = false, env: NodeJS.ProcessEnv = process.env): Promise<IntegrationPlan> {
  const paths = appPaths(env); const configPath = await findOpenCodeConfig(paths.opencodeDir);
  const workspace = remove ? undefined : env.CODE_INTELLIGENCE_WORKSPACE?.trim();
  if (!remove && !workspace) throw new Error("OpenCode installation requires CODE_INTELLIGENCE_WORKSPACE to name the MCP workspace");
  if (workspace) assertSafeId(workspace, "CODE_INTELLIGENCE_WORKSPACE");
  const agentsPath = path.join(paths.opencodeDir, "AGENTS.md"); const pluginPath = path.join(paths.opencodeDir, "plugins", "code-intelligence.ts");
  const configBefore = await readTextIfExists(configPath) || "{}\n";
  const agentsBefore = await readTextIfExists(agentsPath) || "";
  const pluginBefore = await readTextIfExists(pluginPath) || "";
  const pluginOwned = !pluginBefore || pluginBefore.includes("CODE_INTELLIGENCE_MANAGED_PLUGIN");
  if (remove === true && pluginBefore && !pluginOwned) throw new Error("Refusing to remove an unowned plugin file");
  if (!remove && pluginBefore && !pluginOwned) throw new Error("Refusing to overwrite an unowned plugin file");
  const changes = [
    { path: configPath, before: configBefore, after: patchConfig(configBefore, paths.configFile, workspace, remove) },
    { path: agentsPath, before: agentsBefore, after: managedText(agentsBefore, remove ? undefined : managedAgentsBlock) },
    { path: pluginPath, before: pluginBefore, after: remove ? "" : pluginSource.replaceAll("__CODE_INTELLIGENCE_WORKSPACE__", workspace!) },
  ].filter((change) => change.before !== change.after);
  const legacy = legacyDirectMcpNames(configBefore, configPath);
  const warning = legacy.length
    ? `WARNING opencode-mcp: legacy direct registration still exposed (${legacy.join(", ")}); preserved for explicit migration`
    : "";
  return { changes, summary: [changes.map(conciseDiff).join("\n\n") || "No changes required.", warning].filter(Boolean).join("\n\n") };
}

export async function applyOpenCodeIntegration(plan: IntegrationPlan): Promise<string[]> {
  const backups: string[] = [];
  for (const change of plan.changes) {
    await mkdir(path.dirname(change.path), { recursive: true, mode: 0o700 });
    if (change.before) {
      const backup = `${change.path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await atomicWrite(backup, change.before); backups.push(backup);
    }
    if (!change.after && change.path.endsWith("code-intelligence.ts")) await rm(change.path, { force: true });
    else await atomicWrite(change.path, change.after);
  }
  return backups;
}
