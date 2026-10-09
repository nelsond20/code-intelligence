import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";
import { TaskService } from "../task-state/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { planStepInputSchema, type PlanState, type PlanStep, type PlanStepInput } from "./schemas.js";
import { PlanStorage } from "./storage.js";
import { appPaths } from "../workspace/paths.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { walkReadableFiles } from "../search/files.js";
import { canonicalTarget } from "./target-path.js";
import { PlanRepositoryError } from "./repository-error.js";
import { planBindingStale, structuredSpecHash } from "./binding.js";
import { cumulativeCodeHash, reviewReceiptCurrent } from "./review-state.js";
import type { CompactPlanStep } from "../mcp/schemas.js";

type LegacyCompactStep = { kind?: "implementation" | "investigation" | "verification"; title: string; objective: string;
  covers?: string[]; writes?: Array<{ repo: string; path: string }>; acceptance?: string[];
  verification?: Array<{ kind: "test" | "typecheck" | "lint" | "build" | "custom"; program: string; args: string[]; repo?: string }> };

const execFileAsync = promisify(execFile);
function hasConfirmedSpec(spec: string): boolean {
  return spec.split(/\r?\n/).some((line) => {
    const value = line.trim();
    return value && !value.startsWith("#") && value !== "Confirmed design and implementation conclusions are recorded here.";
  });
}

const MUTATING_COMMAND = /(^|[;&|]\s*)(rm|mv|cp|install|touch|truncate|tee|sed\s+-[^\n]*i|perl\s+-[^\n]*i|python(?:3)?\b[^\n]*(?:write|unlink|rename)|node\b[^\n]*(?:writeFile|unlink|rename))\b|(^|[^>])>{1,2}(?!>)|\b(?:writeFile|appendFile|writeTextFile|unlink|rename|rmSync|Bun\.write)\s*\(/i;
const SHELL_META = /[;&|`$<>\n\r]/;
const DEFAULT_VERIFICATION_PROGRAMS = new Set(["npm", "pnpm", "yarn", "node", "pytest", "python", "python3", "cargo", "go", "dotnet", "mvn", "gradle"]);

function shellQuote(value: string): string { return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`; }
export function verificationCommand(verification: { command?: string; program?: string; args?: string[] }): string {
  return verification.command?.trim() || [verification.program!, ...(verification.args || [])].map(shellQuote).join(" ");
}

function validateVerification(verification: { command?: string; program?: string; args?: string[] }): void {
  const command = verificationCommand(verification);
  if (MUTATING_COMMAND.test(command)) throw new Error(`Verification is detectably mutating: ${command}`);
  if (verification.command) {
    if (SHELL_META.test(command)) throw new Error(`Legacy verification cannot contain shell metacharacters: ${command}`);
    const program = command.split(/\s+/)[0]!;
    if (!DEFAULT_VERIFICATION_PROGRAMS.has(program)) throw new Error(`Verification program is not allowed: ${program}`);
  } else if (!verification.program || !DEFAULT_VERIFICATION_PROGRAMS.has(verification.program) || verification.args?.some((arg) => /[\n\r\0]/.test(arg))) {
    throw new Error(`Verification program or argv is not allowed: ${verification.program || "missing"}`);
  }
}

async function contentHash(file: string): Promise<string | undefined> {
  try { return crypto.createHash("sha256").update(await readFile(file)).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

type ShellWork = { scans: number; stats: number; hashes: number; snapshot_bytes: number };
type WriteState = { kind: "file" | "missing" | "other"; hash?: string };
type WriteSnapshot = { repo: string; path: string; state: WriteState };
const writeKey = (item: { repo: string; path: string }) => `${item.repo}:${item.path}`;
const sameState = (a: WriteState, b: WriteState) => a.kind === b.kind && a.hash === b.hash;

async function shellMetadata(registry: WorkspaceRegistry, workspaceId: string, work: ShellWork): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const workspace = await registry.get(workspaceId);
  for (const repository of workspace.repositories) {
    work.scans++;
    for (const relative of await walkReadableFiles(repository.path)) {
      try {
        const info = await stat(path.join(repository.path, relative), { bigint: true }); work.stats++;
        files.set(`${repository.id}:${relative}`, `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return files;
}

export class PlanService {
  constructor(readonly storage = new PlanStorage(), readonly tasks = new TaskService(storage.tasks), readonly registry = new WorkspaceRegistry()) {}

  private async snapshotWrites(workspaceId: string, step: PlanStep): Promise<WriteSnapshot[]> {
    return Promise.all(step.writes.map(async (write) => {
      let repository;
      try { repository = await this.registry.resolveRepository(workspaceId, write.repo); }
      catch (error) { throw new PlanRepositoryError("PLAN_REPOSITORY_RESOLUTION_FAILED", "Resolve repository for write baseline", write.repo, write.path, error); }
      const file = path.join(repository.path, write.path);
      try {
        let info;
        try { info = await lstat(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            await canonicalTarget(repository.path, write.path, true);
            return { repo: write.repo, path: write.path, state: { kind: "missing" as const } };
          }
          throw error;
        }
        // Revalidate containment and the repository read policy at observation time.
        if (info.isSymbolicLink() || !info.isFile()) return { repo: write.repo, path: write.path, state: { kind: "other" as const } };
        await canonicalTarget(repository.path, write.path, false);
        const hash = await contentHash(file);
        if (hash === undefined) throw new Error(`Declared write disappeared during observation: ${write.repo}:${write.path}`);
        return { repo: write.repo, path: write.path, state: { kind: "file" as const, hash } };
      } catch (error) {
        if (error instanceof PlanRepositoryError) throw error;
        throw new PlanRepositoryError("PLAN_BASELINE_FAILED", "Capture write baseline", write.repo, write.path, error);
      }
    }));
  }

  private async snapshotRepositories(workspaceId: string, steps: PlanStep[]): Promise<NonNullable<PlanState["repository_baseline"]>> {
    const ids = new Set(steps.flatMap((step) => step.writes.map((write) => write.repo)));
    const result: NonNullable<PlanState["repository_baseline"]> = [];
    for (const repo of ids) {
      let relative: string | undefined;
      try {
        const repository = await this.registry.resolveRepository(workspaceId, repo);
        const files: Array<{ path: string; hash: string }> = [];
        for (relative of await walkReadableFiles(repository.path)) {
          const hash = await contentHash(path.join(repository.path, relative));
          if (hash === undefined) throw new Error("Repository file disappeared during plan baseline");
          files.push({ path: relative, hash });
        }
        result.push({ repo, files });
      } catch (error) {
        throw new PlanRepositoryError("PLAN_BASELINE_FAILED", "Capture repository baseline", repo, relative, error);
      }
    }
    return result;
  }

  private creationBaseline(plan: PlanState, write: { repo: string; path: string }): WriteSnapshot | undefined {
    const repository = plan.repository_baseline?.find((item) => item.repo === write.repo);
    if (!repository) return undefined;
    const file = repository.files.find((item) => item.path === write.path);
    return { repo: write.repo, path: write.path, state: file ? { kind: "file", hash: file.hash } : { kind: "missing" } };
  }

  private async beginStep(workspaceId: string, step: PlanStep): Promise<void> {
    if (step.kind === "implementation") step.write_baseline = await this.snapshotWrites(workspaceId, step);
  }

  private async configuredChecks(workspaceId: string, step: PlanStep): Promise<Array<{ id: string; command_display: string }>> {
    if (step.kind !== "implementation") return [];
    const workspace = await this.registry.get(workspaceId);
    const repository = workspace.repositories.find((item) => item.id === step.writes[0]?.repo);
    if (!repository) return [];
    let scripts: Record<string, string> = {};
    try { scripts = (JSON.parse(await readFile(path.join(repository.path, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts || {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return workspace.verification.filter((id) => !!scripts[id]).map((id) => ({ id, command_display: `npm run ${id}` }));
  }

  private async repositoryFingerprint(root: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    for (const file of (await walkReadableFiles(root)).sort())
      hash.update(file).update("\0").update(await readFile(path.join(root, file))).update("\0");
    return hash.digest("hex");
  }

  private async runConfiguredChecks(workspaceId: string, step: PlanStep, plan: PlanState): Promise<string[]> {
    const checks = await this.configuredChecks(workspaceId, step);
    if (!checks.length) return [];
    const repository = await this.registry.resolveRepository(workspaceId, step.writes[0]!.repo);
    const content_hash = await this.repositoryFingerprint(repository.path);
    const failures: string[] = [];
    for (const check of checks) {
      const existing = step.check_receipts?.find((item) => item.id === check.id && item.content_hash === content_hash && item.exit_code === 0);
      if (existing) continue;
      const isolatedHome = path.join(appPaths().dataDir, "verification-home");
      await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
      let exit_code = 0; let output = "";
      try {
        const result = await execFileAsync("npm", ["run", check.id], { cwd: repository.path,
          env: { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
            npm_config_userconfig: path.join(isolatedHome, ".npmrc"),
            npm_config_cache: path.join(appPaths().dataDir, "npm-cache"), npm_config_logs_max: "0" },
          timeout: 120_000, maxBuffer: 256_000 });
        output = `${result.stdout}\n${result.stderr}`.slice(-8_000);
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        exit_code = typeof failure.code === "number" ? failure.code : 1;
        output = `${failure.stdout || ""}\n${failure.stderr || failure.message}`.slice(-8_000);
      }
      if (await this.repositoryFingerprint(repository.path) !== content_hash) { exit_code = 1; output += "\nRepository content changed during verification"; }
      step.check_receipts = [...(step.check_receipts || []).filter((item) => item.id !== check.id), { id: check.id, content_hash, exit_code, output }];
      if (exit_code !== 0) failures.push(`${check.command_display} failed (exit ${exit_code}): ${output}`);
    }
    if (failures.length) { plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan); }
    return failures;
  }

  private async reconcileWrites(workspaceId: string, plan: PlanState, step: PlanStep): Promise<{ current: WriteSnapshot[]; changed: WriteSnapshot[] }> {
    if (!step.write_baseline || step.write_baseline.length !== step.writes.length)
      throw new Error(`STEP_NOT_COMPLETE: ${step.id} has no server-owned write baseline; revise the current step before editing`);
    const current = await this.snapshotWrites(workspaceId, step);
    const baseline = new Map(step.write_baseline.map((item) => [writeKey(item), item.state]));
    const planBaseline = new Map(step.plan_baseline?.map((item) => [writeKey(item), item.state]) || []);
    const changed = current.filter((item) => {
      const before = baseline.get(writeKey(item));
      const initial = planBaseline.get(writeKey(item));
      return item.state.kind === "file" && [before, initial].some((state) => state &&
        (state.kind === "missing" || state.kind === "file" && state.hash !== item.state.hash));
    });
    const observed = new Set(step.modified_paths.map(writeKey));
    const newlyObserved = changed.filter((item) => !observed.has(writeKey(item)));
    if (newlyObserved.length) {
      step.mutation_generation += 1;
      step.modified_paths.push(...newlyObserved.map(({ repo, path: targetPath }) => ({ repo, path: targetPath })));
      step.verification = step.verification.map(({ verified_generation: _generation, last_exit: _exit, write_states: _states, ...verification }) => verification);
      await this.markIndexDirty(workspaceId, newlyObserved);
      plan.last_mutation_at = new Date().toISOString(); delete plan.review_receipt;
    }
    return { current, changed };
  }

  private async guardStatus(workspaceId: string, integration: "opencode" | "unknown"): Promise<"enforced" | "degraded" | "unavailable"> {
    if (integration === "unknown") return "unavailable";
    const raw = await readTextIfExists(path.join(appPaths().dataDir, "guard-heartbeat.json"));
    if (!raw) return "unavailable";
    try {
      const value = JSON.parse(raw) as { workspace?: string; at?: string; version?: number; integration?: string };
      return value.workspace === workspaceId && value.integration === integration && value.version === 2 && value.at && Date.now() - Date.parse(value.at) < 300_000 ? "enforced" : "degraded";
    } catch { return "degraded"; }
  }

  private async markIndexDirty(workspaceId: string, targets: Array<{ repo: string; path: string }>): Promise<void> {
    if (!targets.length) return;
    const file = path.join(appPaths().dataDir, "index-dirty", `${workspaceId}.json`); const raw = await readTextIfExists(file);
    let previous: Array<{ repo: string; path: string }> = [];
    try { previous = raw ? JSON.parse(raw) as Array<{ repo: string; path: string }> : []; } catch { /* replace corrupt advisory state */ }
    const merged = [...previous];
    for (const target of targets) if (!merged.some((item) => item.repo === target.repo && item.path === target.path)) merged.push(target);
    await atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`);
  }

  private async active(workspaceId: string) {
    const memory = await this.tasks.current(workspaceId);
    if (!memory) throw new Error("NO_ACTIVE_MEMORY: Select a memory in the local control plane before creating a plan");
    return memory;
  }

  private async spec(workspaceId: string, memoryId: string): Promise<string> {
    if ((await this.storage.tasks.read(workspaceId, memoryId)).spec_archived_at) throw new Error("Restore or replace the archived specification before planning");
    const spec = await this.storage.tasks.readSpec(workspaceId, memoryId);
    if (!hasConfirmedSpec(spec)) throw new Error("A non-empty confirmed spec is required before creating or revising a plan");
    return spec;
  }

  private async compactInput(workspaceId: string, step: CompactPlanStep | LegacyCompactStep): Promise<PlanStepInput> {
    if (step.writes?.some((item) => typeof item !== "string") || "kind" in step) {
      const legacy = step as LegacyCompactStep;
      return { title: legacy.title, objective: legacy.objective, kind: legacy.kind || (legacy.writes?.length ? "implementation" : "investigation"),
        covers: legacy.covers || [], writes: (legacy.writes || []).map((write) => ({ ...write, covers: legacy.covers || [] })),
        acceptance: (legacy.acceptance || []).map((statement) => ({ statement, covers: legacy.covers || [] })), verification: legacy.verification || [] };
    }
    const repositories = (await this.registry.get(workspaceId)).repositories;
    const explicit = "repo" in step && typeof step.repo === "string" ? repositories.find((repo) => repo.id === step.repo) : undefined;
    if ("repo" in step && step.repo && !explicit) throw new Error("Repository ID is not registered in the active workspace");
    return { title: step.title, objective: step.objective, kind: step.writes?.length ? "implementation" : "investigation",
      writes: ((step as CompactPlanStep).writes || []).map((requested) => {
        const normalized = requested.replaceAll("\\", "/");
        const absolute = path.isAbsolute(normalized);
        const matches = absolute
          ? repositories.filter((repo) => normalized.startsWith(`${repo.path}${path.sep}`))
          : repositories.filter((repo) => normalized.startsWith(`${repo.id}/`) || normalized.startsWith(`${path.basename(repo.path)}/`));
        const deepest = Math.max(0, ...matches.map((repo) => repo.path.length));
        const candidates = absolute ? matches.filter((repo) => repo.path.length === deepest) : matches;
        if (absolute && !candidates.length && !explicit) throw new Error("Path escapes the repository");
        if (candidates.length > 1) throw new PlanRepositoryError("PLAN_WRITE_REPOSITORY_AMBIGUOUS", "Resolve write owner", undefined,
          absolute ? undefined : normalized);
        const owner = candidates[0] || explicit || (repositories.length === 1 ? repositories[0] : undefined);
        if (!owner) throw new PlanRepositoryError("PLAN_WRITE_REPOSITORY_REQUIRED", "Resolve write owner", undefined,
          absolute ? undefined : normalized);
        if (explicit && candidates[0] && candidates[0].id !== explicit.id)
          throw new PlanRepositoryError("PLAN_WRITE_REPOSITORY_AMBIGUOUS", "Resolve write owner", explicit.id,
            absolute ? undefined : normalized);
        const prefixes = [`${owner.id}/`, `${path.basename(owner.path)}/`];
        const prefix = absolute ? undefined : prefixes.find((value) => normalized.startsWith(value));
        return { repo: owner.id, path: absolute && candidates[0]
          ? path.relative(owner.path, normalized).replaceAll(path.sep, "/")
          : prefix ? normalized.slice(prefix.length) : requested };
      }),
      acceptance: [], verification: [] };
  }

  private async canonicalPath(workspaceId: string, repo: string, requested: string, allowMissing = true): Promise<string> {
    let repository;
    try { repository = await this.registry.resolveRepository(workspaceId, repo); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown repository")) throw error;
      throw new PlanRepositoryError("PLAN_REPOSITORY_RESOLUTION_FAILED", "Resolve repository for write", repo,
        path.isAbsolute(requested) ? undefined : requested, error);
    }
    return canonicalTarget(repository.path, requested, allowMissing);
  }

  private async normalizeStep(workspaceId: string, input: PlanStepInput, status: PlanStep["status"], assignedId?: string): Promise<PlanStep> {
    const parsed = planStepInputSchema.parse(input);
    const id = parsed.id || assignedId;
    if (!id) throw new Error("Server could not assign a step id");
    const canonicalWrites = await Promise.all(parsed.writes.map(async (item) => ({ ...item, repo: item.repo, path: await this.canonicalPath(workspaceId, item.repo, item.path) })));
    const byIdentity = new Map<string, (typeof canonicalWrites)[number]>();
    for (const write of canonicalWrites) {
      const key = writeKey(write); const existing = byIdentity.get(key);
      if (existing) existing.covers = [...new Set([...existing.covers, ...write.covers])];
      else byIdentity.set(key, write);
    }
    const writes = [...byIdentity.values()];
    const context = await Promise.all(parsed.context.map(async (item) => ({ ...item, file: await this.canonicalPath(workspaceId, item.repo, item.file, false) })));
    const seen = new Set<string>();
    const verification: Array<(typeof parsed.verification)[number] & { id: string }> = [];
    for (const [index, item] of parsed.verification.entries()) {
      try { validateVerification(item); }
      catch (error) { throw new Error(`Step ${id} verification[${index}]: ${(error as Error).message}`); }
      const command = verificationCommand(item);
      if (seen.has(command)) throw new Error(`Step ${id} contains duplicate verification at verification[${index}]`);
      seen.add(command);
      if (item.repo) {
        try { await this.registry.resolveRepository(workspaceId, item.repo); }
        catch { throw new Error(`Step ${id} verification[${index}].repo is not registered`); }
      }
      if (item.cwd !== undefined) {
        if (!item.repo) throw new Error(`Step ${id} verification[${index}].cwd requires a registered repo`);
        if (path.isAbsolute(item.cwd) || item.cwd.split(/[\\/]/).includes("..")) throw new Error(`Step ${id} verification[${index}].cwd must stay inside its repo`);
        const repository = await this.registry.resolveRepository(workspaceId, item.repo);
        const root = await realpath(repository.path);
        let directory: string;
        try { directory = await realpath(path.resolve(root, item.cwd)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Step ${id} verification[${index}].cwd does not exist`);
          throw error;
        }
        const relative = path.relative(root, directory);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Step ${id} verification[${index}].cwd escapes its repo`);
        if (!(await stat(directory)).isDirectory()) throw new Error(`Step ${id} verification[${index}].cwd is not a directory`);
        if (relative) (await RepositoryAccessPolicy.create(root)).assertReadable(relative.replaceAll(path.sep, "/"));
      }
      verification.push({ ...item, id: `V${index + 1}` });
    }
    const acceptance = parsed.acceptance.map((item, index) => {
      const value = typeof item === "string" ? { statement: item, covers: [] as string[], verified_by: [] as number[] } : item;
      const positions = value.verified_by.length ? value.verified_by : verification.map((_, verificationIndex) => verificationIndex + 1);
      for (const position of positions) if (!verification[position - 1]) throw new Error(`Acceptance A${index + 1} references missing verification position ${position} at acceptance[${index}].verified_by; positions are 1-based`);
      return { id: `A${index + 1}`, statement: value.statement, covers: value.covers, verification_ids: [...new Set(positions.map((position) => verification[position - 1]!.id!))] };
    });
    return { ...parsed, id, writes, context, acceptance, status, mutation_generation: 0, modified_paths: [], violations: [], verification };
  }

  private assertUniqueSteps(steps: Array<{ id?: string }>): void {
    const provided = steps.flatMap((step) => step.id ? [step.id] : []);
    if (new Set(provided).size !== provided.length) throw new Error("Plan step ids must be unique");
  }

  async create(workspaceId: string, inputs: PlanStepInput[], exceptions: Array<{ requirement_id: string; reason: string }> = []): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId);
      if (memory.spec_archived_at) throw new Error("SPEC_REQUIRED: Set a new specification before creating a plan");
      const spec = await this.storage.tasks.readStructuredSpec(workspaceId, memory.id);
      if (!spec) throw new Error("SPEC_REQUIRED: Set a structured specification with memory.spec_set before creating a plan");
      if (!inputs.length || inputs.length > 50) throw new Error("A plan requires 1 to 50 steps");
      const previous = await this.storage.read(workspaceId, memory.id);
      if (previous && !previous.archived_at && !["completed", "abandoned"].includes(previous.status)) throw new Error(`Memory already has a ${previous.status} plan; revise, complete, or abandon it`);
      this.assertUniqueSteps(inputs);
      const steps = await Promise.all(inputs.map((step, index) => this.normalizeStep(workspaceId, step, index === 0 ? "current" : "pending", `S${index + 1}`)));
      const repository_baseline = await this.snapshotRepositories(workspaceId, steps);
      for (const step of steps) if (step.kind === "implementation") step.plan_baseline = await this.snapshotWrites(workspaceId, step);
      await this.beginStep(workspaceId, steps[0]!);
      const now = new Date().toISOString();
      const plan: PlanState = { schema_version: 1, memory_id: memory.id, spec_hash: structuredSpecHash(spec), spec_revision: spec.revision, revision: 1,
        status: "active", current_step: 0, steps, repository_baseline, revisions: [], lifecycle: [{ status: "active", at: now }], requirement_exceptions: exceptions, marker_exceptions: [], created_at: now, updated_at: now };
      if (previous) await this.storage.archiveTerminal(workspaceId, previous);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async createCompact(workspaceId: string, steps: Array<CompactPlanStep | LegacyCompactStep>): Promise<PlanState> {
    return this.create(workspaceId, await Promise.all(steps.map((step) => this.compactInput(workspaceId, step))));
  }

  async state(workspaceId: string): Promise<{ plan?: PlanState; stale: boolean }> {
    const memory = await this.tasks.current(workspaceId); if (!memory) return { stale: false };
    const state = await this.stateForMemory(workspaceId, memory.id);
    return state.plan?.archived_at ? { stale: false } : state;
  }

  async stateForMemory(workspaceId: string, memoryId: string): Promise<{ plan?: PlanState; stale: boolean }> {
    const plan = await this.storage.read(workspaceId, memoryId); if (!plan) return { stale: false };
    return { plan, stale: await planBindingStale(this.storage.tasks, workspaceId, plan) };
  }

  async inspect(workspaceId: string, memoryId: string) {
    const { plan, stale } = await this.stateForMemory(workspaceId, memoryId);
    if (!plan) return { plan: null, stale: false, review_gate: "no_plan", traceability: [] };
    const receiptCurrent = await this.reviewCurrent(workspaceId, plan);
    const trustedReceipt = !!(plan.review_receipt && this.tasks.reviewTrust?.verify(plan.review_receipt)
      && "findings" in plan.review_receipt);
    const spec = await this.storage.tasks.readStructuredSpec(workspaceId, memoryId);
    const traceability = (spec?.requirements || []).map((requirement) => {
      const steps = plan.steps.filter((step) => step.covers.includes(requirement.id)).map((step) => {
        const coveredWrites = new Set(step.writes.filter((write) => write.covers.includes(requirement.id)).map((write) => `${write.repo}:${write.path}`));
        const verificationIds = new Set(step.acceptance.filter((item) => item.covers.includes(requirement.id)).flatMap((item) => item.verification_ids));
        const verifications = step.verification.filter((item) => verificationIds.has(item.id || "")).map((item) => ({
          id: item.id, command: verificationCommand(item), expected_exit: item.expect_exit, last_exit: item.last_exit,
          result: item.last_exit === undefined ? "not_run"
            : item.verified_generation === step.mutation_generation && item.last_exit === item.expect_exit ? "pass" : "fail_or_stale" }));
        const modifiedPaths = step.modified_paths.map((item) => `${item.repo}:${item.path}`).filter((item) => coveredWrites.has(item));
        const gaps = [];
        if (step.kind === "implementation" && !modifiedPaths.length) gaps.push("No changed path linked to this requirement");
        if (!verifications.length) gaps.push("No verification linked to this requirement");
        else if (!verifications.some((item) => item.result === "pass")) gaps.push("No passing current verification linked to this requirement");
        return { step_id: step.id, title: step.title, kind: step.kind, status: step.status,
          modified_paths: modifiedPaths, verifications, gaps,
        };
      });
      return { requirement_id: requirement.id, statement: requirement.statement, relation: "structural coverage only",
        steps, gaps: [
          ...(!steps.length ? ["No plan step covers this requirement"] : []),
          ...(stale ? ["Plan is bound to an older specification"] : []),
          ...(!receiptCurrent ? [trustedReceipt ? "Review receipt is blocked or stale" : "Trusted review receipt is missing"] : []),
        ],
        review_status: receiptCurrent ? "approved" : trustedReceipt ? "blocked or stale" : "required",
        review_findings: trustedReceipt && plan.review_receipt && "findings" in plan.review_receipt
          ? plan.review_receipt.findings.filter((item) => !item.covers?.length || item.covers.includes(requirement.id)) : [],
      };
    });
    return { plan, stale, review_gate: stale ? "plan_stale" : plan.status === "completed" ? receiptCurrent ? "satisfied" : "legacy_unverified" : plan.status === "final_review"
      ? receiptCurrent ? "ready" : "code_review_required" : "not_ready", receipt_current: receiptCurrent,
      unresolved_markers: plan.status === "final_review" ? await this.unresolvedMarkers(workspaceId, plan) : [], traceability };
  }

  async markWriteNotNeeded(workspaceId: string, memoryId: string, repo: string, file: string, reason: string): Promise<PlanState> {
    const selected = await this.active(workspaceId);
    if (selected.id !== memoryId) throw new Error("Select this memory before resolving its current write");
    return this.reviseOperations(workspaceId, reason, [{ op: "mark_write_not_needed", repo, path: file, reason }], memoryId);
  }

  async allowFinalMarker(workspaceId: string, memoryId: string, repo: string, file: string, reason: string): Promise<PlanState> {
    if (!reason.trim()) throw new Error("An administrative marker exception requires a reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const plan = await this.storage.read(workspaceId, memoryId);
      if (!plan || plan.status !== "final_review") throw new Error("Marker exceptions require final_review");
      if ((await this.stateForMemory(workspaceId, memoryId)).stale) throw new Error("PLAN_STALE: Cannot resolve markers against an older spec");
      const canonical = await this.canonicalPath(workspaceId, repo, file, false);
      if (!plan.steps.some((step) => step.modified_paths.some((item) => item.repo === repo && item.path === canonical))) throw new Error("Marker exception path is outside the cumulative plan delta");
      const repository = await this.registry.resolveRepository(workspaceId, repo);
      const source = await readFile(path.join(repository.path, canonical), "utf8");
      const marker = /\bTODO\b|not implemented|throw new Error\(["']not implemented/i.exec(source)?.[0];
      if (!marker) throw new Error("No unresolved implementation marker exists at this path");
      plan.marker_exceptions = [...plan.marker_exceptions.filter((item) => item.repo !== repo || item.path !== canonical),
        { repo, path: canonical, marker, reason: reason.trim() }];
      plan.revision += 1; plan.updated_at = new Date().toISOString();
      plan.revisions = [...plan.revisions, { revision: plan.revision, reason: `Administrative marker exception: ${reason.trim()}`, at: plan.updated_at }].slice(-20);
      delete plan.review_receipt;
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async current(workspaceId: string, integration: "opencode" | "unknown" = "opencode") {
    const { plan, stale } = await this.state(workspaceId); if (!plan) return { active: false as const };
    if (plan.status === "completed" || plan.status === "abandoned") return { active: false as const, completed: plan.status === "completed", abandoned: plan.status === "abandoned", revision: plan.revision };
    if (plan.status === "final_review") return { active: false as const, status: "final_review" as const, stale, spec_revision: plan.spec_revision,
      review_gate: stale ? "PLAN_STALE" : await this.reviewCurrent(workspaceId, plan) ? "ready" : "CODE_REVIEW_REQUIRED",
      completed_steps: plan.steps.filter((step) => step.status === "completed").length, total: plan.steps.length,
      next_action: stale ? "Ask the operator to resolve the stale plan" : "Invoke code-review-and-quality on the cumulative plan delta; the operator finishes the plan after a clean review" };
    const step = plan.steps[plan.current_step]!;
    const multipleRepositories = (await this.registry.get(workspaceId)).repositories.length > 1;
    const checks = await this.configuredChecks(workspaceId, step);
    const checkRoot = step.writes[0] && (await this.registry.resolveRepository(workspaceId, step.writes[0].repo)).path;
    const checkHash = checks.length && checkRoot ? await this.repositoryFingerprint(checkRoot) : undefined;
    return { active: (plan.status === "active") as boolean, status: plan.status, guard_status: plan.status === "active" ? await this.guardStatus(workspaceId, integration) : "unavailable", stale,
      stale_reason: stale ? "The memory specification changed after this plan was created; ask the operator to abandon and recreate the plan" : undefined,
      spec_revision: plan.spec_revision, revision: plan.revision, position: plan.current_step + 1, total: plan.steps.length,
      next_action: stale ? "Ask the operator to resolve the stale plan" : plan.status === "active" ? "Work only the current step, then call complete_current" : "Ask the operator to reactivate or abandon the plan",
      step: { id: step.id, title: step.title, objective: step.objective, writes: step.acceptance.length ? step.writes : step.writes.map((write) => multipleRepositories ? writeKey(write) : write.path),
        required_checks: checks.map((check) => ({ ...check, current: !!step.check_receipts?.some((receipt) =>
          receipt.id === check.id && receipt.content_hash === checkHash && receipt.exit_code === 0) })), modified_paths: step.modified_paths,
        ...(step.acceptance.length ? { acceptance: step.acceptance,
          verification: step.verification.map((verification) => ({ id: verification.id, command: verificationCommand(verification), current: verification.verified_generation === step.mutation_generation })) } : {}) } };
  }

  async context(workspaceId: string): Promise<string> {
    const current = await this.current(workspaceId);
    if (!("step" in current) || !current.step) return "## ACTIVE PLAN\n\nNone.";
    return ["## ACTIVE PLAN", `Status: ${current.stale ? "STALE" : "active"}; revision ${current.revision}`,
      `Current: ${current.position}/${current.total} — ${current.step.id} ${current.step.title}`,
      `Goal: ${current.step.objective}`, `Write: ${current.step.writes.map((item) => typeof item === "string" ? item : `${item.repo}:${item.path}`).join(", ")}`].join("\n\n");
  }

  async complete(workspaceId: string, allowFinalReview = true) {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || !["active", "final_review"].includes(plan.status)) throw new Error("No active plan");
      if (stale) return { advanced: false, message: "STEP NOT COMPLETE", missing: ["plan is stale because the confirmed spec changed"] };
      if (plan.status === "final_review") {
        if (!allowFinalReview) throw new Error("CODE_REVIEW_REQUIRED: Final plan completion belongs to the operator after the cumulative review gate");
        const gaps: string[] = []; const covered = new Set(plan.steps.flatMap((item) => item.covers));
        gaps.push(...(await this.unresolvedMarkers(workspaceId, plan)).map((item) => `${item} contains an unresolved implementation marker`));
        if (!(await this.reviewCurrent(workspaceId, plan))) {
          gaps.push("CODE_REVIEW_REQUIRED: a fresh, clean code-review-and-quality receipt is required for the cumulative plan code state");
        }
        if (gaps.length) return { advanced: false, message: "FINAL REVIEW NOT COMPLETE", missing: gaps };
        plan.status = "completed"; plan.updated_at = new Date().toISOString();
        plan.final_evidence = { covered_requirements: [...covered], modified_paths: [...new Set(plan.steps.flatMap((step) => step.modified_paths.map((item) => `${item.repo}:${item.path}`)))],
          verifications: plan.steps.flatMap((step) => step.verification.map(verificationCommand)), completed_at: plan.updated_at };
        await this.storage.write(workspaceId, plan); return { advanced: true, plan_completed: true, final_evidence: plan.final_evidence };
      }
      const step = plan.steps[plan.current_step]!; const missing: string[] = [];
      if (step.status !== "current") missing.push("current step is not active");
      if (step.pending_shell || step.pending_mutation) missing.push("tool effects have not been verified by the guard");
      for (const violation of step.violations) missing.push(`guard violation at ${violation.repo}:${violation.path}: ${violation.reason}`);
      let contentDeltaVerified = false;
      if (step.kind === "implementation") {
        const { current, changed } = await this.reconcileWrites(workspaceId, plan, step);
        const changedKeys = new Set(changed.map(writeKey));
        const planBaseline = new Map(step.plan_baseline?.map((item) => [writeKey(item), item.state]) || []);
        for (const item of current) {
          const before = planBaseline.get(writeKey(item));
          if (before && item.state.kind === "file" && !sameState(before, item.state)) changedKeys.add(writeKey(item));
        }
        contentDeltaVerified = changedKeys.size > 0;
        for (const write of step.writes) if (!write.not_needed_reason && !changedKeys.has(writeKey(write))) {
          const state = current.find((item) => writeKey(item) === writeKey(write))!.state;
          missing.push(`${writeKey(write)} ${state.kind === "other" ? "is not a regular readable file" : "is unchanged from the server-owned baseline (no filesystem content delta)"}`);
        }
        for (const verification of step.verification) if (verification.write_states &&
          (verification.write_states.length !== current.length || verification.write_states.some((item, index) =>
            writeKey(item) !== writeKey(current[index]!) || !sameState(item.state, current[index]!.state)))) {
          missing.push(`${verificationCommand(verification)} predates the current declared write content`);
        }
      }
      if (!missing.length) missing.push(...await this.runConfiguredChecks(workspaceId, step, plan));
      for (const verification of step.verification) {
        if (verification.verified_generation !== step.mutation_generation || verification.last_exit !== verification.expect_exit) {
          missing.push(`${verificationCommand(verification)} has not passed for mutation generation ${step.mutation_generation}`);
        }
      }
      if (missing.length) { await this.storage.write(workspaceId, plan); return { advanced: false, message: "STEP_NOT_COMPLETE", missing, content_delta_verified: contentDeltaVerified }; }
      step.status = "completed"; const completed = plan.current_step;
      if (completed + 1 < plan.steps.length) { plan.current_step += 1; plan.steps[plan.current_step]!.status = "current"; await this.beginStep(workspaceId, plan.steps[plan.current_step]!); }
      else { plan.status = "final_review"; plan.lifecycle.push({ status: "final_review", at: new Date().toISOString() }); }
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
      return { advanced: true, completed_step: step.id, plan_completed: false, final_review: plan.status === "final_review", content_delta_verified: contentDeltaVerified,
        current_step: plan.status === "active" ? plan.steps[plan.current_step]!.id : undefined };
    });
  }

  async completeCurrent(workspaceId: string) {
    return this.complete(workspaceId, false);
  }

  async reviseCurrentCompact(workspaceId: string, reason: string, input: CompactPlanStep | LegacyCompactStep): Promise<PlanState> {
    if (!reason.trim() || reason.trim().length > 2_000) throw new Error("Plan revision requires a bounded reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      await this.active(workspaceId);
      const { plan, stale } = await this.state(workspaceId);
      if (!plan || plan.status !== "active") throw new Error("No active plan");
      if (stale) throw new Error("PLAN_STALE: The memory specification changed; ask the operator to resolve the plan");
      const old = plan.steps[plan.current_step]!;
      const revised = await this.normalizeStep(workspaceId, await this.compactInput(workspaceId, input), "current", old.id);
      const allowed = new Set(revised.writes.map((write) => `${write.repo}:${write.path}`));
      const snapshot = revised.kind === "implementation" ? await this.snapshotWrites(workspaceId, revised) : [];
      const migrated = old.modified_paths.map((item) => {
        if (allowed.has(writeKey(item))) return item;
        const corrected = revised.writes.find((write) => write.repo === item.repo && item.path === `${write.repo}/${write.path}`);
        const initial = corrected && this.creationBaseline(plan, corrected);
        const current = corrected && snapshot.find((entry) => writeKey(entry) === writeKey(corrected));
        if (corrected && initial && current?.state.kind === "file" && !sameState(initial.state, current.state))
          return { repo: corrected.repo, path: corrected.path };
        throw new Error("Revised current step cannot discard paths already modified");
      });
      revised.modified_paths = [...new Map(migrated.map((item) => [writeKey(item), item])).values()];
      revised.mutation_generation = old.mutation_generation; revised.violations = old.violations;
      revised.write_baseline = old.write_baseline;
      revised.plan_baseline = old.plan_baseline;
      if (!revised.write_baseline || revised.writes.some((write) => !revised.write_baseline!.some((item) => writeKey(item) === writeKey(write)))) {
        revised.write_baseline = revised.writes.map((write) => old.write_baseline?.find((item) => writeKey(item) === writeKey(write)) || snapshot.find((item) => writeKey(item) === writeKey(write))!);
      }
      if (revised.kind === "implementation") {
        revised.plan_baseline = revised.writes.map((write) => old.plan_baseline?.find((item) => writeKey(item) === writeKey(write))
          || this.creationBaseline(plan, write) || snapshot.find((item) => writeKey(item) === writeKey(write))!);
      }
      const steps = [...plan.steps]; steps[plan.current_step] = revised;
      plan.steps = steps; plan.revision += 1; plan.updated_at = new Date().toISOString();
      plan.revisions.push({ revision: plan.revision, reason: reason.trim(), at: plan.updated_at, previous_step: old });
      plan.revisions = plan.revisions.slice(-20);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async codeStateHash(workspaceId: string, plan: PlanState): Promise<string> {
    return cumulativeCodeHash(workspaceId, plan, this.registry);
  }

  private async reviewCurrent(workspaceId: string, plan: PlanState): Promise<boolean> {
    return reviewReceiptCurrent(workspaceId, plan, this.registry, this.tasks.reviewTrust);
  }

  private async unresolvedMarkers(workspaceId: string, plan: PlanState): Promise<string[]> {
    const markers = /\bTODO\b|not implemented|throw new Error\(["']not implemented/i;
    const unresolved: string[] = [];
    for (const item of plan.steps.flatMap((step) => step.modified_paths)) {
      if (plan.marker_exceptions.some((exception) => exception.repo === item.repo && exception.path === item.path)) continue;
      try { const repository = await this.registry.resolveRepository(workspaceId, item.repo);
        if (markers.test(await readFile(path.join(repository.path, item.path), "utf8"))) unresolved.push(`${item.repo}:${item.path}`); }
      catch { unresolved.push(`${item.repo}:${item.path}`); }
    }
    return [...new Set(unresolved)];
  }

  async revise(workspaceId: string, reason: string, currentInput: PlanStepInput, futureInputs: PlanStepInput[] = []): Promise<PlanState> {
    if (!reason.trim() || reason.trim().length > 2_000) throw new Error("Plan revision requires a bounded reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId); await this.spec(workspaceId, memory.id);
      const existing = await this.storage.read(workspaceId, memory.id); if (!existing || existing.status !== "active") throw new Error("No active plan");
      if ((await this.stateForMemory(workspaceId, memory.id)).stale) throw new Error("PLAN_STALE: The memory specification changed; abandon and recreate this plan");
      const current = existing.steps[existing.current_step]!;
      if (currentInput.id !== current.id) throw new Error(`Revision cannot skip the server-owned current step ${current.id}`);
      this.assertUniqueSteps([currentInput, ...futureInputs]);
      const revisedCurrent = await this.normalizeStep(workspaceId, currentInput, "current", current.id);
      await this.beginStep(workspaceId, revisedCurrent);
      const future = await Promise.all(futureInputs.map((step, index) => this.normalizeStep(workspaceId, step, "pending", `S${existing.current_step + index + 2}`)));
      existing.steps = [...existing.steps.slice(0, existing.current_step), revisedCurrent, ...future];
      existing.revision += 1; existing.updated_at = new Date().toISOString();
      existing.revisions = [...existing.revisions, { revision: existing.revision, reason: reason.trim(), at: existing.updated_at }].slice(-20);
      await this.storage.write(workspaceId, existing); return existing;
    });
  }

  async reviseOperations(workspaceId: string, reason: string, operations: Array<
    { op: "replace_current"; step: PlanStepInput } | { op: "append_steps"; steps: PlanStepInput[] } | { op: "drop_future" }
    | { op: "mark_write_not_needed"; repo: string; path: string; reason: string }
    | { op: "set_requirement_exception"; requirement_id: string; reason: string }
    | { op: "allow_marker"; repo: string; path: string; marker: string; reason: string }>, expectedMemoryId?: string): Promise<PlanState> {
    if (!reason.trim() || reason.trim().length > 2_000) throw new Error("Plan revision requires a bounded reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId); await this.spec(workspaceId, memory.id);
      if (expectedMemoryId && memory.id !== expectedMemoryId) throw new Error("Selected memory changed before plan resolution");
      const plan = await this.storage.read(workspaceId, memory.id); if (!plan || plan.status !== "active") throw new Error("No active plan");
      if ((await this.stateForMemory(workspaceId, memory.id)).stale) throw new Error("PLAN_STALE: The memory specification changed; abandon and recreate this plan");
      for (const operation of operations) {
        if (operation.op === "replace_current") {
          const replacement = await this.normalizeStep(workspaceId,
            { ...operation.step, id: plan.steps[plan.current_step]!.id }, "current", plan.steps[plan.current_step]!.id);
          await this.beginStep(workspaceId, replacement);
          plan.steps[plan.current_step] = replacement;
        }
        else if (operation.op === "drop_future") plan.steps = plan.steps.slice(0, plan.current_step + 1);
        else if (operation.op === "append_steps") {
          let next = Math.max(...plan.steps.map((item) => Number(item.id.slice(1)) || 0)) + 1;
          for (const input of operation.steps) plan.steps.push(await this.normalizeStep(workspaceId, input, "pending", `S${next++}`));
        } else if (operation.op === "mark_write_not_needed") {
          const canonical = await this.canonicalPath(workspaceId, operation.repo, operation.path); const write = plan.steps[plan.current_step]!.writes.find((item) => item.repo === operation.repo && item.path === canonical);
          if (!write) throw new Error(`Current step does not contain write ${operation.repo}:${operation.path}`); write.not_needed_reason = operation.reason.trim();
        } else if (operation.op === "set_requirement_exception") {
          plan.requirement_exceptions = [...plan.requirement_exceptions.filter((item) => item.requirement_id !== operation.requirement_id),
            { requirement_id: operation.requirement_id, reason: operation.reason.trim() }];
        } else {
          const canonical = await this.canonicalPath(workspaceId, operation.repo, operation.path);
          plan.marker_exceptions = [...plan.marker_exceptions.filter((item) => item.repo !== operation.repo || item.path !== canonical || item.marker !== operation.marker),
            { repo: operation.repo, path: canonical, marker: operation.marker, reason: operation.reason.trim() }];
        }
      }
      plan.revision += 1; plan.updated_at = new Date().toISOString();
      plan.revisions = [...plan.revisions, { revision: plan.revision, reason: reason.trim(), at: plan.updated_at }].slice(-20);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async captureMutation(workspaceId: string, targets: Array<{ repo: string; path: string }>): Promise<void> {
    await this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) throw new Error("No valid active plan");
      const step = plan.steps[plan.current_step]!;
      step.pending_mutation = { targets: await Promise.all(targets.map(async (target) => {
        const repository = await this.registry.resolveRepository(workspaceId, target.repo);
        return { ...target, hash: await contentHash(path.join(repository.path, target.path)) };
      })) };
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
    });
  }

  async recordMutation(workspaceId: string, targets: Array<{ repo: string; path: string }> = []): Promise<boolean> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) throw new Error("No valid active plan");
      const step = plan.steps[plan.current_step]!;
      const pending = step.pending_mutation?.targets || targets.map((target) => ({ ...target, hash: undefined }));
      const changed: Array<{ repo: string; path: string }> = [];
      for (const target of pending) {
        const repository = await this.registry.resolveRepository(workspaceId, target.repo);
        const next = await contentHash(path.join(repository.path, target.path));
        if (next !== target.hash) changed.push({ repo: target.repo, path: target.path });
      }
      delete step.pending_mutation;
      if (!changed.length) { plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan); return false; }
      step.mutation_generation += 1;
      for (const target of changed) if (!step.modified_paths.some((item) => item.repo === target.repo && item.path === target.path)) step.modified_paths.push(target);
      step.verification = step.verification.map(({ verified_generation: _generation, last_exit: _exit, ...verification }) => verification);
      await this.markIndexDirty(workspaceId, changed);
      plan.updated_at = new Date().toISOString(); plan.last_mutation_at = plan.updated_at; delete plan.review_receipt; await this.storage.write(workspaceId, plan);
      return true;
    });
  }

  async recordVerification(workspaceId: string, command: string, exitCode: number): Promise<boolean> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) return false;
      const step = plan.steps[plan.current_step]!;
      if (!step.verification.some((item) => verificationCommand(item) === command)) return false;
      const current = step.kind === "implementation" ? (await this.reconcileWrites(workspaceId, plan, step)).current : [];
      const verification = step.verification.find((item) => verificationCommand(item) === command)!;
      verification.last_exit = exitCode;
      if (exitCode === verification.expect_exit) { verification.verified_generation = step.mutation_generation; verification.write_states = current; }
      else { delete verification.verified_generation; delete verification.write_states; }
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan); return true;
    });
  }

  async captureShell(workspaceId: string): Promise<ShellWork> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) throw new Error("No valid active plan");
      const work: ShellWork = { scans: 0, stats: 0, hashes: 0, snapshot_bytes: 0 };
      const files = await shellMetadata(this.registry, workspaceId, work);
      const allowedHashes: Array<[string, string | null]> = [];
      const workspace = await this.registry.get(workspaceId);
      for (const write of plan.steps[plan.current_step]!.writes) {
        const repository = workspace.repositories.find((item) => item.id === write.repo)!;
        const key = `${write.repo}:${write.path}`;
        const hash = await contentHash(path.join(repository.path, write.path)); work.hashes++;
        allowedHashes.push([key, hash || null]);
      }
      const snapshot = gzipSync(JSON.stringify([...files]), { level: 6 }).toString("base64");
      work.snapshot_bytes = Buffer.byteLength(snapshot) + Buffer.byteLength(JSON.stringify(allowedHashes));
      plan.steps[plan.current_step]!.pending_shell = { snapshot, allowed_hashes: allowedHashes, snapshot_bytes: work.snapshot_bytes };
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
      return work;
    });
  }

  async recordShell(workspaceId: string, command: string, exitCode: number): Promise<{ verified: boolean; changed: string[]; violations: string[]; work?: ShellWork }> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) return { verified: false, changed: [], violations: [] };
      const step = plan.steps[plan.current_step]!;
      const pending = step.pending_shell;
      if (!pending) throw new Error("Shell snapshot is missing; command effects cannot be verified");
      const work: ShellWork = { scans: 0, stats: 0, hashes: 0, snapshot_bytes: "snapshot_bytes" in pending ? pending.snapshot_bytes : Buffer.byteLength(JSON.stringify(pending)) };
      const before = "snapshot" in pending
        ? new Map<string, string>(JSON.parse(gunzipSync(Buffer.from(pending.snapshot, "base64")).toString("utf8")) as Array<[string, string]>)
        : new Map(pending.files.map((item) => [`${item.repo}:${item.path}`, item.hash]));
      let after = await shellMetadata(this.registry, workspaceId, work);
      if ("files" in pending) {
        const hashes = new Map<string, string>();
        const workspace = await this.registry.get(workspaceId);
        for (const key of after.keys()) {
          const [repo, ...parts] = key.split(":"); const repository = workspace.repositories.find((item) => item.id === repo)!;
          const hash = await contentHash(path.join(repository.path, parts.join(":"))); work.hashes++;
          if (hash) hashes.set(key, hash);
        }
        after = hashes;
      }
      const candidates = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
      const allowed = new Set(step.writes.map((item) => `${item.repo}:${item.path}`));
      const violations = candidates.filter((item) => !allowed.has(item));
      const workspace = await this.registry.get(workspaceId);
      const allowedBefore = "allowed_hashes" in pending ? new Map(pending.allowed_hashes) : before;
      const authorized: string[] = [];
      for (const item of candidates.filter((key) => allowed.has(key))) {
        const [repo, ...parts] = item.split(":"); const repository = workspace.repositories.find((value) => value.id === repo)!;
        const hash = await contentHash(path.join(repository.path, parts.join(":"))); work.hashes++;
        if ((allowedBefore.get(item) || undefined) !== hash) authorized.push(item);
      }
      const changed = [...violations, ...authorized];
      delete step.pending_shell;
      const now = new Date().toISOString();
      for (const item of violations) { const [repo, ...parts] = item.split(":"); step.violations.push({ repo: repo!, path: parts.join(":"), reason: "shell changed a path outside the current write-set", at: now }); }
      if (authorized.length) {
        step.mutation_generation += 1;
        for (const item of authorized) { const [repo, ...parts] = item.split(":"); const target = { repo: repo!, path: parts.join(":") };
          if (!step.modified_paths.some((entry) => entry.repo === target.repo && entry.path === target.path)) step.modified_paths.push(target); }
        step.verification = step.verification.map(({ verified_generation: _generation, last_exit: _exit, ...verification }) => verification);
        await this.markIndexDirty(workspaceId, authorized.map((item) => { const [repo, ...parts] = item.split(":"); return { repo: repo!, path: parts.join(":") }; }));
        plan.last_mutation_at = now; delete plan.review_receipt;
      }
      let verified = false;
      if (changed.length === 0) {
        if (step.verification.some((item) => verificationCommand(item) === command.trim())) {
          const current = step.kind === "implementation" ? (await this.reconcileWrites(workspaceId, plan, step)).current : [];
          const verification = step.verification.find((item) => verificationCommand(item) === command.trim())!;
          verification.last_exit = exitCode;
          if (exitCode === verification.expect_exit) { verification.verified_generation = step.mutation_generation; verification.write_states = current; verified = true; }
          else { delete verification.verified_generation; delete verification.write_states; }
        }
      }
      plan.updated_at = now; await this.storage.write(workspaceId, plan); return { verified, changed, violations, work };
    });
  }

  async transition(workspaceId: string, status: "suspended" | "active" | "abandoned", reason?: string): Promise<PlanState> {
    const memory = await this.active(workspaceId);
    return this.transitionForMemory(workspaceId, memory.id, status, reason);
  }

  async transitionForMemory(workspaceId: string, memoryId: string, status: "suspended" | "active" | "final_review" | "abandoned", reason?: string): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const plan = await this.storage.read(workspaceId, memoryId);
      if (!plan || ["completed", "abandoned"].includes(plan.status)) throw new Error("No non-terminal plan");
      if (status === "active" && (plan.status !== "suspended" || plan.suspended_from_final_review)) throw new Error("Only a suspended execution plan can be activated; resume final review separately");
      if (status === "suspended" && plan.status !== "active" && plan.status !== "final_review") throw new Error("Only an active or final-review plan can be suspended");
      if (status === "final_review" && (plan.status !== "suspended" || !plan.suspended_from_final_review)) throw new Error("Final review can only resume after it was suspended, or after the last step passes its checks");
      if (status === "abandoned" && !reason?.trim()) throw new Error("Abandoning a plan requires a reason");
      if (status === "active" || status === "final_review") {
        if (plan.archived_at) throw new Error("Restore this archived plan before reactivating it");
        const selected = await this.tasks.current(workspaceId);
        if (selected?.id !== memoryId) throw new Error("Select this memory as active before resuming its plan");
        if ((await this.stateForMemory(workspaceId, memoryId)).stale) throw new Error("PLAN_STALE: Abandon and recreate this plan against the current spec");
        if (status === "active" && plan.imported_from && !plan.repository_baseline) {
          plan.repository_baseline = await this.snapshotRepositories(workspaceId, plan.steps);
          for (const step of plan.steps) if (step.kind === "implementation") step.plan_baseline = await this.snapshotWrites(workspaceId, step);
          await this.beginStep(workspaceId, plan.steps[0]!);
        }
      }
      if (status === "suspended" && plan.status === "final_review") plan.suspended_from_final_review = true;
      else if (status !== "suspended") delete plan.suspended_from_final_review;
      plan.status = status; plan.updated_at = new Date().toISOString();
      plan.lifecycle = [...plan.lifecycle, { status, reason: reason?.trim(), at: plan.updated_at }].slice(-50);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async setArchived(workspaceId: string, memoryId: string, archived: boolean): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const plan = await this.storage.read(workspaceId, memoryId);
      if (!plan) throw new Error("No plan for this memory");
      if (!!plan.archived_at === archived) return plan;
      const now = new Date().toISOString();
      if (archived) {
        if (plan.status === "final_review") plan.archived_previous_status = "final_review";
        if (plan.status === "active" || plan.status === "final_review") {
          plan.status = "suspended";
          plan.lifecycle = [...plan.lifecycle, { status: "suspended", reason: "Archived by operator", at: now }].slice(-50);
        }
        plan.archived_at = now;
      } else {
        delete plan.archived_at;
        if (plan.archived_previous_status === "final_review") {
          plan.status = "final_review";
          plan.lifecycle = [...plan.lifecycle, { status: "final_review", reason: "Restored by operator", at: now }].slice(-50);
        }
        delete plan.archived_previous_status;
      }
      plan.updated_at = now;
      await this.storage.write(workspaceId, plan);
      return plan;
    });
  }

  async deleteForMemory(workspaceId: string, memoryId: string): Promise<void> {
    await this.storage.tasks.workspaceLock(workspaceId, async () => {
      if (!(await this.storage.read(workspaceId, memoryId))) throw new Error("No plan for this memory");
      await this.storage.delete(workspaceId, memoryId);
    });
  }
}
