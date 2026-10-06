import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MemoryControlService } from "./service.js";
import { controlPage } from "./page.js";

const workspaceBody = z.object({ workspace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const decisionBody = workspaceBody.extend({ plan_decision: z.enum(["suspend", "abandon"]).optional() }).strict();
const phases = z.enum(["investigation", "implementation", "verification", "review"]);
const title = z.string().trim().max(120);

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
    if (method === "POST") {
      const value = workspaceBody.extend({ phase: phases.optional(), title: title.optional() }).strict().parse(body);
      return control.create(workspace, value.phase, value.title);
    }
  }
  const noteManage = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)\/notes\/(M[1-9][0-9]*)\/(archive|restore|delete)$/.exec(pathname);
  if (noteManage) {
    if (method !== "POST") throw new Error("Unsupported method");
    workspaceBody.strict().parse(body);
    return noteManage[3] === "delete" ? control.deleteNote(workspace, noteManage[1]!, noteManage[2]!)
      : control.archiveNote(workspace, noteManage[1]!, noteManage[2]!, noteManage[3] === "archive");
  }
  const specManage = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)\/spec\/(archive|restore|delete)$/.exec(pathname);
  if (specManage) {
    if (method !== "POST") throw new Error("Unsupported method");
    workspaceBody.strict().parse(body);
    return specManage[2] === "delete" ? control.deleteSpec(workspace, specManage[1]!)
      : control.archiveSpec(workspace, specManage[1]!, specManage[2] === "archive");
  }
  const planManage = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)\/plan\/(archive|restore|delete)$/.exec(pathname);
  if (planManage) {
    if (method !== "POST") throw new Error("Unsupported method");
    workspaceBody.strict().parse(body);
    return planManage[2] === "delete" ? control.deletePlan(workspace, planManage[1]!)
      : control.archivePlan(workspace, planManage[1]!, planManage[2] === "archive");
  }
  const planMatch = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)\/plan(?:\/(suspend|reactivate|abandon|finish|resolve-write|allow-marker))?$/.exec(pathname);
  if (planMatch) {
    const id = planMatch[1]!; const action = planMatch[2];
    if (method === "GET" && !action) return control.planDetail(workspace, id);
    if (method !== "POST") throw new Error("Unsupported method");
    if (action === "finish") { workspaceBody.strict().parse(body); return control.planFinish(workspace, id); }
    if (action === "resolve-write" || action === "allow-marker") {
      const value = workspaceBody.extend({ repo: z.string().min(1), path: z.string().min(1), reason: z.string().trim().min(1).max(2_000) }).strict().parse(body);
      return action === "resolve-write" ? control.planResolveWrite(workspace, id, value.repo, value.path, value.reason)
        : control.planAllowMarker(workspace, id, value.repo, value.path, value.reason);
    }
    if (action === "suspend" || action === "reactivate" || action === "abandon") {
      const value = workspaceBody.extend({ reason: z.string().trim().min(1).max(2_000).optional() }).strict().parse(body);
      return control.planTransition(workspace, id, action, value.reason);
    }
  }
  const match = /^\/api\/memories\/([a-z0-9][a-z0-9-]*)(?:\/(activate|pause|complete|phase|rollback|title|archive|restore|delete))?$/.exec(pathname);
  if (!match) throw new Error("Unknown control-plane route");
  const id = match[1]!; const action = match[2];
  if (method === "GET" && !action) return control.detail(workspace, id);
  if (method !== "POST") throw new Error("Unsupported method");
  if (action === "archive" || action === "restore" || action === "delete") {
    workspaceBody.strict().parse(body);
    return action === "delete" ? control.deleteMemory(workspace, id) : control.archiveMemory(workspace, id, action === "archive");
  }
  if (action === "activate" || action === "pause" || action === "complete") {
    const value = decisionBody.parse(body);
    return control[action](workspace, id, value.plan_decision);
  }
  if (action === "phase") {
    const value = workspaceBody.extend({ phase: phases }).strict().parse(body);
    return control.phase(workspace, id, value.phase);
  }
  if (action === "title") {
    const value = workspaceBody.extend({ title: title.min(1) }).strict().parse(body);
    return control.rename(workspace, id, value.title);
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
      if (request.method === "GET" && isControlPagePath(url.pathname)) {
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

export function isControlPagePath(pathname: string): boolean {
  return pathname === "/" || /^\/workspaces\/[a-z0-9][a-z0-9-]*\/memories(?:\/[a-z0-9][a-z0-9-]*\/(?:overview|specification|notes|plan|history))?$/.test(pathname);
}

export async function serveControlUi(port = 4317): Promise<string> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid UI port");
  const server = createControlServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
}
