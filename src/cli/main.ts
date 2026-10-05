#!/usr/bin/env node
import { WorkspaceRegistry } from "../workspace/registry.js";
import { TaskService } from "../task-state/service.js";
import { resolveWorkspaceId } from "../workspace/registry.js";
import { loadConfig } from "../config/loader.js";
import { SemanticIndex } from "../search/semantic.js";
import { doctor } from "../doctor.js";
import { applyOpenCodeIntegration, planOpenCodeIntegration } from "../integrations/opencode.js";
import { IndexProgressRenderer } from "./progress.js";
import { PlanService } from "../plan/service.js";
import { PlanGuard } from "../plan/guard.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { appPaths } from "../workspace/paths.js";
import path from "node:path";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function options(name: string): string[] { return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []); }
function positional(start: number): string[] {
  const values: string[] = [];
  for (let i = start; i < args.length; i++) {
    if (args[i]!.startsWith("--")) { if (!["--dry-run", "--yes", "--force", "--progress", "--changed"].includes(args[i]!)) i++; continue; }
    values.push(args[i]!);
  }
  return values;
}
function output(value: unknown): void { process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`); }

function workspaceFromArgs(): string { return resolveWorkspaceId(option("--workspace")); }
async function stdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 64_000) throw new Error("Guard input exceeds 64000 bytes"); chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function run(): Promise<void> {
  const [command, subcommand] = args;
  const registry = new WorkspaceRegistry(); const tasks = new TaskService(); const plans = new PlanService(undefined, tasks, registry); const guard = new PlanGuard(plans, registry);
  if (command === "serve-mcp") return (await import("../mcp/server.js")).serveMcp();
  if (command === "integration" && subcommand === "heartbeat") {
    const workspace = workspaceFromArgs(); await atomicWrite(path.join(appPaths().dataDir, "guard-heartbeat.json"),
      `${JSON.stringify({ version: 2, integration: "opencode", workspace, at: new Date().toISOString() })}\n`); return output({ recorded: true });
  }
  if (command === "doctor") { const checks = await doctor(); checks.forEach((check) => output(`${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}`)); if (checks.some((c) => c.status === "error")) process.exitCode = 1; return; }
  if (command === "workspace") {
    if (subcommand === "list") return output(await registry.list());
    if (subcommand === "add") return output(await registry.add(positional(2)[0] || "", options("--repo"), option("--name")));
    if (subcommand === "remove") { await registry.remove(positional(2)[0] || ""); return output({ removed: positional(2)[0] }); }
    if (subcommand === "repo-add") return output(await registry.addRepository(positional(2)[0] || "", option("--path") || "", option("--id")));
    if (subcommand === "repo-remove") { await registry.removeRepository(positional(2)[0] || "", positional(2)[1] || ""); return output({ removed: positional(2)[1] }); }
  }
  if (command === "memory" || command === "task") {
    if (command === "task") process.stderr.write("code-intelligence: 'task' is deprecated; use 'memory'\n");
    const workspace = workspaceFromArgs();
    if (subcommand === "new") return output(await tasks.create(workspace, positional(2).join(" "), { objective: option("--objective"), phase: option("--phase"), activate: !has("--paused") }));
    if (subcommand === "list") return output(await tasks.list(workspace));
    if (subcommand === "current") return output(await tasks.bootstrap(workspace));
    if (subcommand === "activate") return output(await tasks.activate(workspace, positional(2)[0] || ""));
    if (subcommand === "pause" || subcommand === "complete") return output(await tasks.transition(workspace, subcommand === "pause" ? "paused" : "completed", positional(2)[0]));
    if (subcommand === "context") {
      const maxTokens = Number(option("--max-tokens") || 3000); const maxChars = Math.max(400, maxTokens * 4);
      const planContext = await plans.context(workspace);
      const reserved = Math.min(maxChars - 200, planContext.length + 180);
      const memory = await tasks.context(workspace, Math.max(100, Math.floor((maxChars - reserved) / 4)));
      if (memory === "No active memory." && planContext.endsWith("None.")) return output(memory);
      const fixed = ["## RESUME CAPSULE", planContext, "## NEXT ACTION", "Call `plan(action=\"current\")` before the next mutation."].join("\n\n");
      const available = Math.max(0, maxChars - fixed.length - 2); const memoryItems = memory.split("\n\n"); const included: string[] = [];
      for (const item of memoryItems) { if ([...included, item].join("\n\n").length > available - 40) break; included.push(item); }
      return output([fixed, included.join("\n\n"), included.length < memoryItems.length ? "… [memory items omitted]" : ""].filter(Boolean).join("\n\n"));
    }
  }
  if (command === "plan") {
    const workspace = workspaceFromArgs();
    if (subcommand === "current") return output(await plans.current(workspace));
    if (subcommand === "guard-before") {
      const input = await stdinJson();
      const decision = input.kind === "shell"
        ? await guard.beforeShell(workspace, String(input.command || ""))
        : await guard.beforeMutation(workspace, Array.isArray(input.targets) ? input.targets.map(String) : []);
      output(decision); if (!decision.allowed) process.exitCode = 2; return;
    }
    if (subcommand === "guard-after") {
      const input = await stdinJson();
      if (input.kind === "verification") return output({ recorded: await guard.afterVerification(workspace, String(input.command || ""), Number(input.exit_code)) });
      if (input.kind === "shell") return output(await guard.afterShell(workspace, String(input.command || ""), Number(input.exit_code)));
      const changed = await guard.afterMutation(workspace, Array.isArray(input.targets) ? input.targets.map(String) : []);
      return output({ recorded: changed, content_changed: changed });
    }
  }
  if (command === "index") {
    const workspace = workspaceFromArgs(); const config = await loadConfig();
    if (!config.embeddings.enabled) throw new Error("Semantic indexing is disabled in config");
    const repositories = await registry.forScope(workspace, option("--repo") || "all"); const index = new SemanticIndex(config, undefined, fetch, workspace);
    const progress = has("--progress") ? new IndexProgressRenderer() : undefined;
    const dirtyFile = path.join(appPaths().dataDir, "index-dirty", `${workspace}.json`);
    const dirty = has("--changed") ? JSON.parse(await readTextIfExists(dirtyFile) || "[]") as Array<{ repo: string; path: string }> : [];
    const selected = has("--changed") && dirty.length ? repositories.filter((repository) => dirty.some((item) => item.repo === repository.id)) : repositories;
    const results = []; for (const repository of selected) results.push({ repo: repository.id,
      ...(await index.index(repository, has("--force"), undefined, progress ? (event) => progress.render(repository.id, event) : undefined)) });
    if (has("--changed")) await atomicWrite(dirtyFile, "[]\n");
    return output(results);
  }
  if (command === "install-opencode" || command === "uninstall-opencode") {
    const plan = await planOpenCodeIntegration(command === "uninstall-opencode"); output(plan.summary);
    if (has("--dry-run") || !has("--yes")) { if (!has("--dry-run")) output("Preview only. Re-run with --yes to apply."); return; }
    return output({ applied: plan.changes.length, backups: await applyOpenCodeIntegration(plan) });
  }
  output(`Usage:
  code-intelligence doctor
  code-intelligence workspace list|add|remove|repo-add|repo-remove
  code-intelligence index --workspace <id> [--repo <id>] [--force|--changed] [--progress]
  code-intelligence memory new|list|current|activate|pause|complete|context --workspace <id>
  code-intelligence plan current --workspace <id>
  code-intelligence install-opencode|uninstall-opencode [--dry-run] [--yes]
  code-intelligence serve-mcp`);
  if (command) process.exitCode = 1;
}

run().catch((error) => { process.stderr.write(`code-intelligence: ${(error as Error).message}\n`); process.exitCode = 1; });
