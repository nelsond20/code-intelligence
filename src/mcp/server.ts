import { z, ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PlanCreateFailure, ToolRuntime } from "./runtime.js";
import { registerPublicTools } from "./tools.js";
import { parseMemoryAction } from "./schemas.js";
import { StageActionError } from "../orchestration/stage.js";
import { PlanRepositoryError } from "../plan/repository-error.js";

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
  const guidance = candidate && typeof candidate.stage === "string" ? { stage: candidate.stage, required_skill: candidate.required_skill, next_action: candidate.next_action } : {};
  const envelope: unknown = alreadyEnvelope ? value : { status: "ok", data: value, next_action: null, warnings: [], diagnostics: {}, ...guidance };
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

function inputFailure(error: ZodError, action?: string, input?: Record<string, unknown>) {
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
  const currentFields = ["section", "offset", "state_token", "item_id"];
  const readConfusion = action === "spec_set" && currentFields.some((field) => input && field in input);
  const writeConfusion = action === "current" && ["summary", "requirements"].some((field) => input && field in input);
  const correction = readConfusion
    ? "memory.spec_set is a WRITE action that replaces the complete spec and requires summary and requirements. section/offset are only for memory.current READ continuation. Use memory.current to read the current records or spec."
    : writeConfusion ? "memory.current is a READ action. Use memory.spec_set with complete summary and requirements to replace the spec."
      : undefined;
  return { status: "error", code: action ? "INVALID_MEMORY_ACTION_PAYLOAD" : "INVALID_INPUT", message: `${action ? `Invalid memory.${action} payload. ` : ""}${first.message} at ${first.path}${"hint" in first && first.hint ? `. ${first.hint}` : ""}${correction ? ` ${correction}` : ""}`,
    next_action: correction || "Correct the reported fields and retry the same action",
    diagnostics: { action, issues, missing: issues.filter((item) => item.message.startsWith("Required field")).map((item) => item.path),
      unexpected: issues.filter((item) => item.message.startsWith("Unknown field")).map((item) => item.path),
      invalid: issues.filter((item) => !item.message.startsWith("Required field") && !item.message.startsWith("Unknown field")), state_unchanged: true } };
}

function failure(error: unknown, action?: string, input?: Record<string, unknown>) {
  const phase = error instanceof PlanCreateFailure ? error.phase : undefined;
  if (error instanceof PlanCreateFailure) error = error.cause;
  if (error instanceof ZodError) return { ...formatToolResponse(inputFailure(error, action, input)), isError: true };
  if (error instanceof PlanRepositoryError) {
    const correctable = error.code === "PLAN_WRITE_REPOSITORY_REQUIRED" || error.code === "PLAN_WRITE_REPOSITORY_AMBIGUOUS";
    return { ...formatToolResponse({ status: "error", code: error.code,
      message: correctable ? `${error.message}. Use a registered repository prefix or absolute path; use step.repo for an unqualified path.` : error.message,
      next_action: phase === "read_created_plan" ? "Check plan.current before any retry; the plan may have been saved"
        : correctable ? "Specify the write's registered repository and retry plan.create" : "Ask the operator to inspect server diagnostics",
      diagnostics: { operation: error.operation, ...(phase ? { phase } : {}), ...(error.repo ? { repo: error.repo } : {}), ...(error.target ? { path: error.target } : {}),
        retry_same_action: false, state_unchanged: phase !== "read_created_plan" } }), isError: true };
  }
  if (error instanceof StageActionError) return { ...formatToolResponse({
    status: "error", code: error.code, message: error.message,
    ...error.guidance,
    next_action: error.guidance.stage === "planning"
      ? `Do not retry memory.${error.action}. Create the persistent Code Intelligence plan with plan.create.`
      : `Do not retry memory.${error.action}. ${error.guidance.next_action}`,
    diagnostics: { action: error.action, retry_same_action: false, state_unchanged: true },
  }), isError: true };
  const message = error instanceof Error ? error.message : "Request failed";
  const classified = message.startsWith("MEMORY_PAGE_STALE:") ? "MEMORY_PAGE_STALE"
    : message.startsWith("MEMORY_PAGE_TOO_LARGE:") ? "MEMORY_PAGE_TOO_LARGE"
    : message.startsWith("PLAN_PAGE_STALE:") ? "PLAN_PAGE_STALE"
    : message.startsWith("PLAN_PAGE_TOO_LARGE:") ? "PLAN_PAGE_TOO_LARGE"
    : message.startsWith("NO_ACTIVE_MEMORY:") ? "NO_ACTIVE_MEMORY"
    : /Unknown memory record/i.test(message) ? "RECORD_NOT_FOUND"
    : /Unknown requirement in active memory/i.test(message) ? "REQUIREMENT_NOT_FOUND"
    : /Duplicate requirement/i.test(message) ? "INVALID_MEMORY_ACTION_PAYLOAD"
    : /Unknown repository/i.test(message) ? "INVALID_INPUT"
    : message.startsWith("INVALID_EVIDENCE_REF_KIND:") ? "INVALID_EVIDENCE_REF_KIND"
    : /Evidence ref has not been inspected|requires inspected evidence/i.test(message) ? "EVIDENCE_NOT_INSPECTED"
      : /Symlink escapes|Path escapes|excluded by repository|outside registered repositories|not authorized/i.test(message) ? "SECURITY_VIOLATION"
        : /Verification|verification|writable path|cwd/i.test(message) ? "INVALID_VERIFICATION"
          : /No active|active memory|already has|suspended|not terminal|requires a reason|confirmed spec|Unknown memory|Completed tasks/i.test(message) ? "INVALID_STATE" : "REQUEST_FAILED";
  const code = classified === "REQUEST_FAILED" && phase ? "PLAN_CREATE_FAILED" : classified;
  const internal = code === "REQUEST_FAILED" || code === "PLAN_CREATE_FAILED";
  const systemCode = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(error.code)
    ? error.code : undefined;
  return { ...formatToolResponse({ status: "error", code, message: internal
    ? phase ? `plan.create failed during ${phase}; inspect server diagnostics` : "Request failed; inspect current state and server diagnostics"
    : message,
    ...(code === "NO_ACTIVE_MEMORY" ? { stage: "operator_action_required", required_skill: null } : {}),
    next_action: code === "INVALID_EVIDENCE_REF_KIND" ? "Remove the memory record ID from evidence_refs; use a ref from context.find after context.inspect"
      : code === "MEMORY_PAGE_STALE" ? "Restart with memory.current without section, then use the new state_token"
      : code === "PLAN_PAGE_STALE" ? "Restart with plan.current without section, then use the new state_token"
      : code === "NO_ACTIVE_MEMORY" ? "Ask the operator to select an active memory in the local control plane"
      : internal ? "Ask the operator to inspect server diagnostics and check plan.current before any retry" : "Correct the reported condition and retry; use memory.current or plan.current for current state",
    ...(internal ? { diagnostics: { ...(phase ? { operation: "plan.create", phase, plan_may_exist: phase === "read_created_plan" } : {}),
      error_type: error instanceof Error ? error.name : typeof error,
      ...(systemCode ? { system_code: systemCode } : {}), retry_same_action: false } } : {}) }), isError: true };
}

type PublicTool = { name: string; description: string; schema: z.ZodTypeAny; handler: (input: any) => Promise<unknown> };

type SchemaField = Record<string, unknown>;
type ActionBranch = { properties?: Record<string, SchemaField>; required?: string[] };

export function publicInputSchema(schema: z.ZodTypeAny, flattenActionUnion = false) {
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
        // permissive; the internal Zod action union remains the exact validator.
        existing.field = existing.field.type === field.type && typeof field.type === "string"
          ? { type: field.type } : {};
      }
    }
  }
  const requiredFields = branches.map((branch) => ({ action: branch.properties!.action!.const as string,
    fields: (branch.required || []).filter((name) => name !== "action") })).filter((item) => item.fields.length);
  const properties: Record<string, SchemaField> = { action: { type: "string", enum: actions,
    description: flattenActionUnion
      ? `Choose one listed action. ${requiredFields.map((item) => `${item.action} requires ${item.fields.join(" and ")}`).join("; ")}.`
      : "Choose one listed action; see its branch for required fields." } };
  for (const [name, { field, actions: fieldActions }] of Object.entries(rootFields)) {
    const requiredBy = requiredFields.filter((item) => item.fields.includes(name)).map((item) => item.action);
    properties[name] = { ...field, description: `${typeof field.description === "string" ? `${field.description} ` : ""}Used by ${fieldActions.join(", ")}; ${flattenActionUnion
      ? requiredBy.length ? `required for ${requiredBy.join(", ")}` : "optional"
      : "required only where its action branch says so"}.` };
  }
  if (flattenActionUnion) {
    for (const [name, field] of Object.entries(properties)) {
      if (typeof field.$ref !== "string" || !field.$ref.startsWith("#/")) continue;
      const target = field.$ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, input);
      if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`Unresolved plan schema reference: ${field.$ref}`);
      const { $ref: _reference, ...rest } = field;
      properties[name] = { ...structuredClone(target), ...rest };
    }
    const { anyOf: _branches, ...flat } = input as Record<string, unknown>;
    return { ...flat, properties, required: ["action"], additionalProperties: false };
  }
  return { ...input, properties, required: ["action"] };
}

export function createMcpServer(runtime = new ToolRuntime()): Server {
  const server = new Server({ name: "code-intelligence", version: "0.3.0" }, { capabilities: { tools: { listChanged: false } } });
  runtime.clientName = () => server.getClientVersion()?.name;
  const tools = new Map<string, PublicTool>();
  registerPublicTools((name, description, schema, handler) => tools.set(name, { name, description, schema, handler }), runtime);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools.values()].map(({ name, description, schema }) => ({
    name, description, inputSchema: publicInputSchema(schema, name === "plan"),
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return { ...formatToolResponse({ status: "error", code: "UNKNOWN_TOOL", message: "Unknown public tool", next_action: "Use a tool listed by tools/list" }), isError: true };
    try { return formatToolResponse(await tool.handler(tool.name === "memory"
      ? parseMemoryAction((request.params.arguments || {}) as Parameters<typeof parseMemoryAction>[0])
      : tool.schema.parse(request.params.arguments || {}))); }
    catch (error) { return failure(error, tool.name === "memory" && typeof request.params.arguments?.action === "string" ? request.params.arguments.action : undefined,
      tool.name === "memory" ? request.params.arguments : undefined); }
  });
  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
