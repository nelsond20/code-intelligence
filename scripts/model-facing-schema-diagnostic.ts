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

const irrelevantMemoryTransportPaths = new Set([
  "/$schema",
  "/properties/evidence_refs/items/maxLength",
  "/properties/reason/maxLength",
  "/properties/text/maxLength",
]);

function schemaDifferences(expected: unknown, actual: unknown, location = ""): string[] {
  if (hash(expected) === hash(actual)) return [];
  const left = object(expected); const right = object(actual);
  if (left && right) return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .flatMap((key) => schemaDifferences(left[key], right[key], `${location}/${key}`));
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length)
    return expected.flatMap((item, index) => schemaDifferences(item, actual[index], `${location}/${index}`));
  return [location || "/"];
}

function field(schema: JsonObject | undefined, ...parts: string[]): unknown {
  let current: unknown = schema;
  for (const part of parts) current = object(current)?.[part];
  return current;
}

function requirementContract(root: JsonObject | undefined) {
  const item = object(field(root, "properties", "requirements", "items"));
  const required = Array.isArray(item?.required) ? item.required : [];
  const fields = ["statement", "kind", "priority", "id"] as const;
  const properties = object(item?.properties);
  return {
    required,
    id_optional: item ? !required.includes("id") : null,
    field_description_present: Object.fromEntries(fields.map((name) => [name, typeof object(properties?.[name])?.description === "string"])),
    field_enums: Object.fromEntries(["kind", "priority"].map((name) => [name,
      Array.isArray(object(properties?.[name])?.enum) ? object(properties?.[name])!.enum : []])),
    missing_guidance: fields.filter((name) => typeof object(properties?.[name])?.description !== "string"),
  };
}

function planContract(root: JsonObject | undefined) {
  const step = object(field(root, "properties", "steps", "items"));
  const verification = object(field(root, "properties", "steps", "items", "properties", "verification", "items"));
  const write = object(field(root, "properties", "steps", "items", "properties", "writes", "items"));
  return {
    actions: field(root, "properties", "action", "enum"),
    step_required: step?.required,
    kinds: field(step, "properties", "kind", "enum"),
    acceptance_type: field(step, "properties", "acceptance", "items", "type"),
    verification_required: verification?.required,
    verification_kinds: field(verification, "properties", "kind", "enum"),
    write_required: write?.required,
    write_type: write?.type,
    revise_step_present: field(root, "properties", "step") !== undefined,
  };
}

function summarize(tool: DiagnosticTool | undefined, name: "memory" | "plan") {
  const root = tool?.schema;
  const critical = name === "memory"
    ? ["properties.action", "properties.summary", "properties.requirements", "properties.requirements.items.properties.statement",
      "properties.requirements.items.properties.kind", "properties.requirements.items.properties.priority"]
    : ["properties.steps", "properties.steps.items.properties.title", "properties.steps.items.properties.objective",
      "properties.steps.items.properties.writes"];
  return { observed: Boolean(tool), schema_observed: Boolean(root), schema_sha256: hash(root), description_sha256: hash(tool?.description),
    description_length: tool?.description?.length ?? null,
    root_properties: Object.keys(object(root?.properties) || {}), root_required: Array.isArray(root?.required) ? root.required : [],
    missing_critical_fields: critical.filter((key) => field(root, ...key.split(".")) === undefined),
    requirement_contract: name === "memory" ? requirementContract(root) : undefined,
    plan_contract: name === "plan" ? planContract(root) : undefined };
}

export function compareToolSchemas(server: DiagnosticTool[], toolSearch?: DiagnosticTool[], initial?: DiagnosticTool[]) {
  return (["memory", "plan"] as const).map((name) => {
    const find = (items: DiagnosticTool[] | undefined) => items?.find((tool) => publicName(tool.name) === name);
    const listed = find(server); const searched = find(toolSearch); const before = find(initial);
    if (!listed) throw new Error(`Missing ${name} schema from tools/list`);
    const initialDifferences = before?.schema && name === "memory"
      ? schemaDifferences(listed.schema, before.schema).map((location) => ({ path: location,
        category: irrelevantMemoryTransportPaths.has(location) ? "B" as const : "A" as const })) : null;
    const initialDescriptionMatches = before?.description === undefined ? null : hash(before.description) === hash(listed.description);
    return { tool: name, tool_search_equals_tools_list: searched?.schema ? hash(searched.schema) === hash(listed.schema) : null,
      tool_search_description_equals_tools_list: searched ? hash(searched.description) === hash(listed.description) : null,
      initial_equals_tools_list: before?.schema ? hash(before.schema) === hash(listed.schema) : null,
      initial_description_equals_tools_list: initialDescriptionMatches,
      ...(name === "plan" ? { initial_plan_contract_preserved: Boolean(before?.schema && initialDescriptionMatches === true
        && hash(planContract(before.schema)) === hash(planContract(listed.schema))) } : {}),
      ...(name === "memory" ? { initial_schema_differences: initialDifferences,
        initial_spec_set_contract_preserved: before?.schema && initialDescriptionMatches === true
          ? initialDifferences?.every((difference) => difference.category === "B") === true : false } : {}),
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
  if (!exportPath && !initialPath) {
    throw new Error("Usage: model-facing-schema-diagnostic [--export <Qwen export.md>] [--initial <model-bound tools.json>] [--require-match]");
  }
  const exported = exportPath ? parseToolSearchExport(await readFile(exportPath, "utf8")) : undefined;
  const initial = initialPath ? parseInitialTools(JSON.parse(await readFile(initialPath, "utf8"))) : undefined;
  const result = compareToolSchemas(await listedTools(), exported, initial);
  console.log(JSON.stringify({ schema_version: 1, initial_capture_supplied: Boolean(initialPath), tools: result }, null, 2));
  const differs = (observed: boolean, schemaMatch: boolean | null, descriptionMatch: boolean | null, required: boolean) =>
    required && !observed || observed && (schemaMatch !== true || descriptionMatch !== true);
  if (requireMatch && result.some((tool) =>
    Boolean(exportPath) && differs(tool.tool_search.observed, tool.tool_search_equals_tools_list,
      tool.tool_search_description_equals_tools_list, tool.tool === "memory") ||
    Boolean(initialPath) && (tool.tool === "memory" && tool.initial_spec_set_contract_preserved !== true
      || tool.tool === "plan" && tool.initial_plan_contract_preserved !== true))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
