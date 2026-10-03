import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { runProcess } from "../src/shared/process.js";
import { ReadonlyGit } from "../src/git/readonly.js";
import { GitBackend } from "../src/broker/git-backend.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { isolated, fixture } from "./helpers.js";
import { ToolRuntime } from "../src/mcp/runtime.js";

async function gitAvailable(): Promise<boolean> { try { return (await runProcess("git", ["--version"], { timeoutMs: 3000 })).code === 0; } catch { return false; } }
async function git(cwd: string, args: string[]) { const result = await runProcess("git", args, { cwd, timeoutMs: 10_000 }); if (result.code !== 0) throw new Error(result.stderr); return result.stdout; }

test("Git is an internal read-only bounded source with round-trip refs", async (context) => {
  if (!await gitAvailable()) return context.skip("functional Git binary is unavailable");
  const env = await isolated("git");
  try {
    const repoPath = path.join(env.root, "repo"); await cp(fixture("backend"), repoPath, { recursive: true });
    await git(repoPath, ["init"]); await git(repoPath, ["config", "user.name", "Fixture"]); await git(repoPath, ["config", "user.email", "fixture@example.invalid"]);
    await git(repoPath, ["add", "src/PlanningService.ts"]); await git(repoPath, ["commit", "-m", "add planning duration calculation"]);
    const serviceFile = path.join(repoPath, "src", "PlanningService.ts");
    await writeFile(serviceFile, (await readFile(serviceFile, "utf8")).replace("Math.round", "Math.floor"));
    await git(repoPath, ["add", "src/PlanningService.ts"]); await git(repoPath, ["commit", "-m", "change planning duration"]);
    await git(repoPath, ["config", "diff.external", "/definitely/not/executable"]); await git(repoPath, ["config", "core.pager", "/definitely/not/executable"]);
    const hookMarker = path.join(env.root, "hook-ran"); const hook = path.join(repoPath, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`); await chmod(hook, 0o755);
    const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces")); await registry.add("history", [repoPath]);
    const backend = new GitBackend(registry, async () => "history", 2000);
    const found = await backend.find({ query: "planning duration", sources: ["git"] });
    assert.ok(found.length > 0); assert.match(found[0]!.ref, /^git:\/\/repo\/commit\/[0-9a-f]+$/);
    const summary = await backend.inspect({ ref: found[0]!.ref, view: "summary" }) as { files: unknown[]; file_refs: Array<{ ref: string }> };
    assert.ok(summary.files.length > 0); assert.match(summary.file_refs[0]!.ref, /^git:\/\/repo\/file\//);
    const diff = await backend.inspect({ ref: found[0]!.ref, view: "diff" }) as { diff: string; truncated: boolean };
    assert.ok(Buffer.byteLength(diff.diff) < 2200); assert.equal(typeof diff.truncated, "boolean");
    await assert.rejects(backend.inspect({ ref: "git://repo/commit/not-a-hash", view: "summary" }), /Invalid commit hash/);
    await assert.rejects(backend.inspect({ ref: "git://missing/commit/abcdef1", view: "summary" }), /Unknown repository/);
    await assert.rejects(access(hookMarker), /ENOENT/, "read-only inspection must not execute repository hooks");
    process.env.CODE_INTELLIGENCE_WORKSPACE = "history"; const runtime = new ToolRuntime(); await runtime.memory({ action: "new", title: "History review" });
    await runtime.contextInspect({ ref: found[0]!.ref, view: "impact" });
    const state = await runtime.tasks.current("history"); assert.equal(state?.inspected_commits[0]?.repo, "repo"); assert.equal(state?.active_hypotheses.length, 0);
    const api = Object.getOwnPropertyNames(ReadonlyGit.prototype);
    for (const forbidden of ["add", "commit", "push", "pull", "fetch", "checkout", "reset", "merge", "rebase", "remote"]) assert.equal(api.includes(forbidden), false);
  } finally { await env.cleanup(); }
});
