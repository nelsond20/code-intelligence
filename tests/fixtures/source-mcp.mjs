import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture-source", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ["search", "inspect"].map((name) => ({
  name, inputSchema: { type: "object" },
})) }));
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args = request.params.arguments || {};
  const value = request.params.name === "search"
    ? { schema_version: 1, results: [{ id: "stable-guide", title: "Guide", snippet: `Result for ${String(args.query)}`,
      score: 0.9, metadata: {}, views: ["content"] }] }
    : { schema_version: 1, content: `Content for ${String(args.id)}`, metadata: {} };
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
});
await server.connect(new StdioServerTransport());
