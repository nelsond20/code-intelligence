import { z, ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolRuntime } from "./runtime.js";
import { registerPublicTools } from "./tools.js";
import { parseMemoryAction } from "./schemas.js";

function compact(value: unknown, maxString: number, maxArray: number): unknown {
  if (typeof value === "string") return value.length <= maxString ? value : `${value.slice(0, Math.max(0, maxString - 20))}… [truncated]`;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => compact(item, maxString, maxArray));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, maxString, maxArray)]));
  return value;
}

export function formatToolResponse(value: unknown) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const alreadyEnvelope = candidate && ["ok", "error", "degraded"].includes(String(candidate.status))
    && ("data" in candidate || "message" in candidate);
  const envelope: unknown = alreadyEnvelope ? value : { status: "ok", data: value, next_action: null, warnings: [], diagnostics: {} };
  let bounded: unknown = envelope; let serialized = JSON.stringify(bounded); let truncated = false;
  for (const [maxString, maxArray] of [[8_000, 50], [4_000, 20], [2_000, 10], [1_000, 5], [500, 3]] as const) {
    if (Buffer.byteLength(serialized) <= 24_000) break;
    bounded = compact(envelope, maxString, maxArray); serialized = JSON.stringify(bounded); truncated = true;
  }
  if (Buffer.byteLength(serialized) > 24_000) bounded = { status: "degraded", truncated: true, next_action: "Repeat the request with a narrower scope or lower limit" };
  else if (truncated && bounded && typeof bounded === "object" && !Array.isArray(bounded)) bounded = { ...(bounded as Record<string, unknown>), truncated: true };
  return { content: [{ type: "text" as const, text: JSON.stringify(bounded) }] };
}

function location(parts: Array<string | number>): string {
  return parts.reduce<string>((result, part) => typeof part === "number" ? `${result}[${part}]` : result ? `${result}.${part}` : part, "") || "input";
}

function inputFailure(error: ZodError, action?: string) {
  const hints: Record<string, string> = {
    requirementIds: "Use covers: [\"R1\"] on the step, write, or acceptance object.",
    requirements_coverage: "Use covers: [\"R1\"] on the step, write, or acceptance object.",
    criterion: "Use statement for acceptance text.",
    body: "Use text for memory.note.",
    tags: "Use repo, file, and symbol for record context; tags is unsupported.",
    spec: "For spec_set, put summary and requirements at the top level.",
  };
  const expanded = error.issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    const ranked = issue.unionErrors.map((branch) => branch.issues).sort((a, b) => {
      const score = (items: typeof a) => items.reduce((total, item) => total + item.path.length + (item.code === "unrecognized_keys" ? 10 : 0), 0);
      return score(b) - score(a);
    });
    return ranked[0] || [issue];
  });
  const issues = expanded.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") return issue.keys.map((key) => ({ path: location([...issue.path, key]), message: `Unknown field ${key}`, hint: hints[key] }));
    if (issue.code === "invalid_union_discriminator") return [{ path: location(issue.path), message: `Invalid action; valid actions: ${issue.options.join(", ")}` }];
    const path = location(issue.path);
    const message = issue.code === "invalid_type" && issue.received === "undefined" ? `Required field ${path} is missing` : issue.message;
    return [{ path, message }];
  }).sort((a, b) => Number(b.message.startsWith("Unknown field")) - Number(a.message.startsWith("Unknown field")) || a.path.localeCompare(b.path));
  const first = issues[0] || { path: "input", message: "Invalid input" };
  return { status: "error", code: action ? "INVALID_MEMORY_ACTION_PAYLOAD" : "INVALID_INPUT", message: `${action ? `Invalid memory.${action} payload. ` : ""}${first.message} at ${first.path}${"hint" in first && first.hint ? `. ${first.hint}` : ""}`, next_action: "Correct the reported fields and retry the same action",
    diagnostics: { action, issues, missing: issues.filter((item) => item.message.startsWith("Required field")).map((item) => item.path),
      unexpected: issues.filter((item) => item.message.startsWith("Unknown field")).map((item) => item.path),
      invalid: issues.filter((item) => !item.message.startsWith("Required field") && !item.message.startsWith("Unknown field")), state_unchanged: true } };
}

function failure(error: unknown, action?: string) {
  if (error instanceof ZodError) return { ...formatToolResponse(inputFailure(error, action)), isError: true };
  const message = error instanceof Error ? error.message : "Request failed";
  const code = message.startsWith("NO_ACTIVE_MEMORY:") ? "NO_ACTIVE_MEMORY"
    : /Unknown memory record/i.test(message) ? "RECORD_NOT_FOUND"
    : /Unknown requirement in active memory/i.test(message) ? "REQUIREMENT_NOT_FOUND"
    : /Duplicate requirement/i.test(message) ? "INVALID_MEMORY_ACTION_PAYLOAD"
    : /Unknown repository/i.test(message) ? "INVALID_INPUT"
      : /coverage|covers|requirement.*test verification/i.test(message) ? "COVERAGE_GAP"
    : /Evidence ref has not been inspected|requires inspected evidence/i.test(message) ? "EVIDENCE_NOT_INSPECTED"
      : /Symlink escapes|Path escapes|excluded by repository|outside registered repositories|not authorized/i.test(message) ? "SECURITY_VIOLATION"
        : /Verification|verification|writable path|cwd/i.test(message) ? "INVALID_VERIFICATION"
          : /No active|active memory|already has|suspended|not terminal|requires a reason|confirmed spec|Unknown memory|Completed tasks/i.test(message) ? "INVALID_STATE" : "REQUEST_FAILED";
  return { ...formatToolResponse({ status: "error", code, message: code === "REQUEST_FAILED" ? "Request failed; inspect current state and server diagnostics" : message,
    next_action: code === "NO_ACTIVE_MEMORY" ? "Ask the operator to select an active memory in the local control plane" : "Correct the reported condition and retry; use memory.current or plan.current for current state" }), isError: true };
}

type PublicTool = { name: string; description: string; schema: z.ZodTypeAny; handler: (input: any) => Promise<unknown> };

type SchemaField = Record<string, unknown>;
type ActionBranch = { properties?: Record<string, SchemaField>; required?: string[] };

export function publicInputSchema(schema: z.ZodTypeAny) {
  const input = { ...zodToJsonSchema(schema), type: "object" as const };
  const branches = (input as { anyOf?: ActionBranch[] }).anyOf;
  if (!branches?.length || !branches.every((branch) => typeof branch.properties?.action?.const === "string")) return input;
  const actions = branches.map((branch) => branch.properties!.action!.const as string);
  const rootFields: Record<string, { field: SchemaField; actions: string[] }> = {};
  for (const branch of branches) {
    const action = branch.properties!.action!.const as string;
    for (const [name, field] of Object.entries(branch.properties!)) {
      if (name === "action") continue;
      const existing = rootFields[name];
      if (!existing) { rootFields[name] = { field, actions: [action] }; continue; }
      existing.actions.push(action);
      if (JSON.stringify(existing.field) !== JSON.stringify(field)) {
        // Shared fields can have action-specific bounds. Keep the root projection
        // permissive; the selected anyOf branch remains the exact validator.
        existing.field = existing.field.type === field.type && typeof field.type === "string"
          ? { type: field.type } : {};
      }
    }
  }
  const properties: Record<string, SchemaField> = { action: { type: "string", enum: actions,
    description: "Choose one listed action; see its branch for required fields." } };
  for (const [name, { field, actions: fieldActions }] of Object.entries(rootFields)) {
    properties[name] = { ...field, description: `${typeof field.description === "string" ? `${field.description} ` : ""}Used by ${fieldActions.join(", ")}; required only where its action branch says so.` };
  }
  return { ...input, properties,
    required: ["action"] };
}

export function createMcpServer(runtime = new ToolRuntime()): Server {
  const server = new Server({ name: "code-intelligence", version: "0.3.0" }, { capabilities: { tools: { listChanged: false } } });
  runtime.clientName = () => server.getClientVersion()?.name;
  const tools = new Map<string, PublicTool>();
  registerPublicTools((name, description, schema, handler) => tools.set(name, { name, description, schema, handler }), runtime);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools.values()].map(({ name, description, schema }) => ({
    name, description, inputSchema: publicInputSchema(schema),
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return { ...formatToolResponse({ status: "error", code: "UNKNOWN_TOOL", message: "Unknown public tool", next_action: "Use a tool listed by tools/list" }), isError: true };
    try { return formatToolResponse(await tool.handler(tool.name === "memory"
      ? parseMemoryAction((request.params.arguments || {}) as Parameters<typeof parseMemoryAction>[0])
      : tool.schema.parse(request.params.arguments || {}))); }
    catch (error) { return failure(error, tool.name === "memory" && typeof request.params.arguments?.action === "string" ? request.params.arguments.action : undefined); }
  });
  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
