// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolRuntime } from "./runtime.js";
import { registerPublicTools } from "./tools.js";

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
function failure(error: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", code: "REQUEST_FAILED", message: (error as Error).message,
  next_action: "Correct the reported input or inspect current memory/plan state and retry" }) }], isError: true }; }
export function createMcpServer(runtime = new ToolRuntime()): McpServer {
  const server = new McpServer({ name: "code-intelligence", version: "0.2.0" });
  const register = (name: string, description: string, schema: any, handler: (input: any) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema }, async (input: unknown) => {
      try { return formatToolResponse(await handler(schema.parse(input))); } catch (error) { return failure(error); }
    });
  };
  registerPublicTools(register, runtime);
  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
