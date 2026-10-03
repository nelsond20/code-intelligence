// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-ignore -- declared runtime dependency; allows offline validation before npm installs the SDK.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolRuntime } from "./runtime.js";
import { truncateUtf8 } from "../shared/fs.js";
import { registerPublicTools } from "./tools.js";

function response(value: unknown) {
  const serialized = JSON.stringify(value); const bounded = truncateUtf8(serialized, 24_000);
  return { content: [{ type: "text" as const, text: bounded.truncated ? JSON.stringify({ truncated: true, preview: bounded.text }) : bounded.text }] };
}
function failure(error: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify({ error: (error as Error).message }) }], isError: true }; }
export function createMcpServer(runtime = new ToolRuntime()): McpServer {
  const server = new McpServer({ name: "code-intelligence", version: "0.1.0" });
  const register = (name: string, description: string, schema: any, handler: (input: any) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema }, async (input: unknown) => {
      try { return response(await handler(schema.parse(input))); } catch (error) { return failure(error); }
    });
  };
  registerPublicTools(register, runtime);
  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
