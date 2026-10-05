import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

type JsonObject = Record<string, unknown>;
export type DiagnosticTool = { name: string; description?: string; schema?: JsonObject };

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function normalizeTool(value: unknown): DiagnosticTool | undefined {
  const raw = object(value);
  const inner = object(raw?.function) || raw;
  if (!inner || typeof inner.name !== "string") return undefined;
  const schema = object(inner.parametersJsonSchema) || object(inner.inputSchema) || object(inner.parameters);
  return { name: inner.name, description: typeof inner.description === "string" ? inner.description : undefined, schema };
}

function publicName(value: string): "memory" | "plan" | undefined {
  if (value === "memory" || value.endsWith("__memory")) return "memory";
  if (value === "plan" || value.endsWith("__plan")) return "plan";
  return undefined;
}

export function parseToolSearchExport(source: string): DiagnosticTool[] {
  const matches = [...source.matchAll(/<function>(\{[^\n]+\})<\/function>/g)];
  return matches.map((match) => normalizeTool(JSON.parse(match[1]!))).filter((tool): tool is DiagnosticTool => Boolean(tool && publicName(tool.name)));
}

export function parseInitialTools(source: unknown): DiagnosticTool[] {
  const container = object(source);
  if (!Array.isArray(container?.tools)) throw new Error("Initial capture must contain a tools array");
  return container.tools.map(normalizeTool).filter((tool): tool is DiagnosticTool => Boolean(tool && publicName(tool.name)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const fields = object(value);
  return fields ? Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, canonical(item)])) : value;
}

function hash(value: unknown): string | null {
  return value === undefined ? null : crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function field(schema: JsonObject | undefined, ...parts: string[]): unknown {
  let current: unknown = schema;
  for (const part of parts) current = object(current)?.[part];
  return current;
}

function summarize(tool: DiagnosticTool | undefined, name: "memory" | "plan") {
  const root = tool?.schema;
  const critical = name === "memory"
    ? ["properties.title", "properties.summary", "properties.requirements", "properties.requirements.items.properties.statement",
      "properties.requirements.items.properties.kind", "properties.requirements.items.properties.priority"]
    : ["properties.steps", "properties.steps.items.properties.title", "properties.steps.items.properties.objective",
      "properties.steps.items.properties.acceptance", "properties.steps.items.properties.verification"];
  return { observed: Boolean(tool), schema_observed: Boolean(root), schema_sha256: hash(root), description_sha256: hash(tool?.description),
    root_properties: Object.keys(object(root?.properties) || {}), root_required: Array.isArray(root?.required) ? root.required : [],
    missing_critical_fields: critical.filter((key) => field(root, ...key.split(".")) === undefined) };
}

export function compareToolSchemas(server: DiagnosticTool[], toolSearch: DiagnosticTool[], initial?: DiagnosticTool[]) {
  return (["memory", "plan"] as const).map((name) => {
    const find = (items: DiagnosticTool[] | undefined) => items?.find((tool) => publicName(tool.name) === name);
    const listed = find(server); const searched = find(toolSearch); const before = find(initial);
    if (!listed || !searched?.schema) throw new Error(`Missing ${name} schema from tools/list or ToolSearch`);
    return { tool: name, tool_search_equals_tools_list: hash(searched.schema) === hash(listed.schema),
      tool_search_description_equals_tools_list: hash(searched.description) === hash(listed.description),
      initial_equals_tools_list: before?.schema ? hash(before.schema) === hash(listed.schema) : null,
      tools_list: summarize(listed, name), tool_search: summarize(searched, name), initial: summarize(before, name) };
  });
}

async function listedTools(): Promise<DiagnosticTool[]> {
  const server = createMcpServer();
  const client = new Client({ name: "local-schema-diagnostic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    return (await client.listTools()).tools.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.inputSchema as JsonObject }));
  } finally { await client.close(); await server.close(); }
}

async function main(args: string[]): Promise<void> {
  let exportPath: string | undefined; let initialPath: string | undefined; let requireMatch = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--require-match") { requireMatch = true; continue; }
    if (arg !== "--export" && arg !== "--initial") throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--export") exportPath = value; else initialPath = value;
  }
  if (!exportPath) {
    throw new Error("Usage: model-facing-schema-diagnostic --export <Qwen export.md> [--initial <model-bound tools.json>] [--require-match]");
  }
  const exported = parseToolSearchExport(await readFile(exportPath, "utf8"));
  const initial = initialPath ? parseInitialTools(JSON.parse(await readFile(initialPath, "utf8"))) : undefined;
  const result = compareToolSchemas(await listedTools(), exported, initial);
  console.log(JSON.stringify({ schema_version: 1, initial_capture_supplied: Boolean(initialPath), tools: result }, null, 2));
  if (requireMatch && result.some((tool) => !tool.tool_search_equals_tools_list || !tool.tool_search_description_equals_tools_list)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
