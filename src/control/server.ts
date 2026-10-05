import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MemoryControlService } from "./service.js";
import { controlPage } from "./page.js";

const workspaceBody = z.object({ workspace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const decisionBody = workspaceBody.extend({ plan_decision: z.enum(["suspend", "abandon"]).optional() }).strict();
const phases = z.enum(["investigation", "implementation", "verification", "review"]);

export async function controlRoute(method: string, pathname: string, query: URLSearchParams, body: unknown, control: MemoryControlService): Promise<unknown> {
  if (method === "GET" && pathname === "/api/workspaces") return control.workspaces();
  const workspace = method === "GET" ? workspaceBody.parse({ workspace: query.get("workspace") }).workspace : workspaceBody.parse(body).workspace;
  if (method === "GET" && pathname === "/api/active") {
    await control.registry.get(workspace);
    const active = await control.tasks.current(workspace);
    const plan = active ? await control.planStorage.read(workspace, active.id) : undefined;
    return { memory_id: active?.id, plan_status: plan?.status };
  }
  if (pathname === "/api/memories") {
    if (method === "GET") return control.list(workspace, Object.fromEntries(query.entries()));
    if (method === "POST") return control.create(workspace, phases.parse((body as { phase?: unknown }).phase || "investigation"));
  }
  const match = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)(?:\/(activate|pause|complete|phase|rollback))?$/.exec(pathname);
  if (!match) throw new Error("Unknown control-plane route");
  const id = match[1]!; const action = match[2];
  if (method === "GET" && !action) return control.detail(workspace, id);
  if (method !== "POST") throw new Error("Unsupported method");
  if (action === "activate" || action === "pause" || action === "complete") {
    const value = decisionBody.parse(body);
    return control[action](workspace, id, value.plan_decision);
  }
  if (action === "phase") {
    const value = workspaceBody.extend({ phase: phases }).strict().parse(body);
    return control.phase(workspace, id, value.phase);
  }
  if (action === "rollback") {
    const value = workspaceBody.extend({ revision: z.number().int().min(1) }).strict().parse(body);
    return control.rollback(workspace, id, value.revision);
  }
  throw new Error("Unknown control-plane route");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 64_000) throw new Error("Request body exceeds 64000 bytes");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

export function createControlServer(control = new MemoryControlService()) {
  const token = randomBytes(24).toString("hex");
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host || "";
      if (!/^127\.0\.0\.1(?::[0-9]+)?$/.test(host)) return json(response, 403, { error: "Loopback host required" });
      const url = new URL(request.url || "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` });
        response.end(controlPage(token)); return;
      }
      if (!url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" });
      if (request.headers["x-control-token"] !== token) return json(response, 403, { error: "Control token required" });
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(response, 403, { error: "Origin mismatch" });
      if (request.method !== "GET" && request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
      if (request.method === "POST" && request.headers["content-type"] !== "application/json") return json(response, 415, { error: "JSON required" });
      const result = await controlRoute(request.method, url.pathname, url.searchParams, request.method === "POST" ? await readBody(request) : undefined, control);
      json(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      json(response, /Unknown|Invalid|Required|confirmation|ACTIVE_PLAN|Zod/.test(message) || error instanceof z.ZodError ? 400 : 409,
        { error: error instanceof z.ZodError ? error.issues.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ") : message });
    }
  });
  return server;
}

export async function serveControlUi(port = 4317): Promise<string> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid UI port");
  const server = createControlServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
}
