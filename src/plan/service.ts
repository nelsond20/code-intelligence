import crypto from "node:crypto";
import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";
import { TaskService } from "../task-state/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { planStepInputSchema, type PlanState, type PlanStep, type PlanStepInput } from "./schemas.js";
import { PlanStorage } from "./storage.js";
import { appPaths } from "../workspace/paths.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { walkReadableFiles } from "../search/files.js";
import { canonicalTarget } from "./target-path.js";
import { planBindingStale, structuredSpecHash } from "./binding.js";
import { cumulativeCodeHash, reviewReceiptCurrent } from "./review-state.js";
import type { CompactPlanStep } from "../mcp/schemas.js";

function expandCompactStep(step: CompactPlanStep): PlanStepInput {
  return { ...step, writes: (step.writes || []).map((write) => ({ ...write, covers: step.covers })), context: step.context || [],
    acceptance: step.acceptance.map((statement) => ({ statement, covers: step.covers })), verification: step.verification };
}
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

export class PlanService {
  constructor(readonly storage = new PlanStorage(), readonly tasks = new TaskService(storage.tasks), readonly registry = new WorkspaceRegistry()) {}

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
    const spec = await this.storage.tasks.readSpec(workspaceId, memoryId);
    if (!hasConfirmedSpec(spec)) throw new Error("A non-empty confirmed spec is required before creating or revising a plan");
    return spec;
  }

  private async assertCoverage(workspaceId: string, memoryId: string, steps: PlanStep[], exceptions: Array<{ requirement_id: string; reason: string }> = []): Promise<void> {
    const spec = await this.storage.tasks.readStructuredSpec(workspaceId, memoryId);
    if (!spec) return;
    const requirements = new Map(spec.requirements.map((item) => [item.id, item]));
    const exceptionIds = new Set(exceptions.map((item) => item.requirement_id));
    for (const exception of exceptions) if (!requirements.has(exception.requirement_id)) throw new Error(`Exception references unknown requirement ${exception.requirement_id}`);
    const covered = new Set<string>();
    for (const [stepIndex, step] of steps.entries()) {
      for (const requirement of step.covers) {
        if (!requirements.has(requirement)) throw new Error(`Step ${step.id} covers unknown requirement ${requirement}`);
        covered.add(requirement);
      }
      if (step.covers.length === 0) throw new Error(`Step ${step.id} does not cover a requirement at steps[${stepIndex}].covers; use covers with R* IDs from the active spec: ${[...requirements.keys()].join(", ")}`);
      for (const [writeIndex, write] of step.writes.entries()) {
        if (write.covers.length === 0) throw new Error(`Write ${write.repo}:${write.path} has no requirement coverage at steps[${stepIndex}].writes[${writeIndex}].covers; use a subset of step covers: ${step.covers.join(", ")}`);
        for (const requirement of write.covers) if (!step.covers.includes(requirement)) throw new Error(`Write ${write.repo}:${write.path} covers ${requirement} outside step ${step.id}`);
      }
      for (const [acceptanceIndex, acceptance] of step.acceptance.entries()) {
        if (!acceptance.covers.length) throw new Error(`Step ${step.id} has an acceptance criterion without requirement coverage at steps[${stepIndex}].acceptance[${acceptanceIndex}].covers; use an object with statement and covers (legacy strings cannot cover a structured spec). Expected a subset of: ${step.covers.join(", ")}`);
        for (const requirement of acceptance.covers) if (!step.covers.includes(requirement)) throw new Error(`Acceptance ${acceptance.id} covers ${requirement} outside step ${step.id}`);
        if (!acceptance.verification_ids.length) throw new Error(`Acceptance ${acceptance.id} has no verification`);
        for (const verificationId of acceptance.verification_ids) if (!step.verification.some((item) => item.id === verificationId)) throw new Error(`Acceptance ${acceptance.id} references unknown verification ${verificationId}`);
      }
    }
    const missing = spec.requirements.filter((item) => item.priority === "must" && !covered.has(item.id) && !exceptionIds.has(item.id));
    if (missing.length) throw new Error(`Must requirements without plan coverage: ${missing.map((item) => item.id).join(", ")}`);
    const behavior = spec.requirements.filter((item) => item.kind === "behavior" && item.priority === "must" && covered.has(item.id));
    for (const requirement of behavior) {
      if (!steps.some((step) => step.covers.includes(requirement.id) && step.verification.some((verification) => verification.kind === "test"))) {
        throw new Error(`Behavior requirement ${requirement.id} requires a test verification; add verification with kind: "test" to a step whose covers includes ${requirement.id}`);
      }
    }
  }

  private async canonicalPath(workspaceId: string, repo: string, requested: string, allowMissing = true): Promise<string> {
    const repository = await this.registry.resolveRepository(workspaceId, repo);
    return canonicalTarget(repository.path, requested, allowMissing);
  }

  private async normalizeStep(workspaceId: string, input: PlanStepInput, status: PlanStep["status"], assignedId?: string): Promise<PlanStep> {
    const parsed = planStepInputSchema.parse(input);
    const id = parsed.id || assignedId;
    if (!id) throw new Error("Server could not assign a step id");
    const writes = await Promise.all(parsed.writes.map(async (item) => ({ ...item, repo: item.repo, path: await this.canonicalPath(workspaceId, item.repo, item.path) })));
    const unique = new Set(writes.map((item) => `${item.repo}:${item.path}`));
    if (unique.size !== writes.length) throw new Error(`Step ${id} contains duplicate writable paths`);
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
      const spec = await this.storage.tasks.readStructuredSpec(workspaceId, memory.id);
      if (!spec) throw new Error("SPEC_REQUIRED: Set a structured specification with memory.spec_set before creating a plan");
      if (!inputs.length || inputs.length > 50) throw new Error("A plan requires 1 to 50 steps");
      const previous = await this.storage.read(workspaceId, memory.id);
      if (previous && !["completed", "abandoned"].includes(previous.status)) throw new Error(`Memory already has a ${previous.status} plan; revise, complete, or abandon it`);
      this.assertUniqueSteps(inputs);
      const steps = await Promise.all(inputs.map((step, index) => this.normalizeStep(workspaceId, step, index === 0 ? "current" : "pending", `S${index + 1}`)));
      await this.assertCoverage(workspaceId, memory.id, steps, exceptions);
      const now = new Date().toISOString();
      const plan: PlanState = { schema_version: 1, memory_id: memory.id, spec_hash: structuredSpecHash(spec), spec_revision: spec.revision, revision: 1,
        status: "active", current_step: 0, steps, revisions: [], lifecycle: [{ status: "active", at: now }], requirement_exceptions: exceptions, marker_exceptions: [], created_at: now, updated_at: now };
      if (previous) await this.storage.archiveTerminal(workspaceId, previous);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async createCompact(workspaceId: string, steps: CompactPlanStep[]): Promise<PlanState> {
    return this.create(workspaceId, steps.map(expandCompactStep));
  }

  async state(workspaceId: string): Promise<{ plan?: PlanState; stale: boolean }> {
    const memory = await this.tasks.current(workspaceId); if (!memory) return { stale: false };
    return this.stateForMemory(workspaceId, memory.id);
  }

  async stateForMemory(workspaceId: string, memoryId: string): Promise<{ plan?: PlanState; stale: boolean }> {
    const plan = await this.storage.read(workspaceId, memoryId); if (!plan) return { stale: false };
    return { plan, stale: await planBindingStale(this.storage.tasks, workspaceId, plan) };
  }

  async inspect(workspaceId: string, memoryId: string) {
    const { plan, stale } = await this.stateForMemory(workspaceId, memoryId);
    if (!plan) return { plan: null, stale: false, review_gate: "no_plan" };
    const receiptCurrent = await this.reviewCurrent(workspaceId, plan);
    return { plan, stale, review_gate: stale ? "plan_stale" : plan.status === "completed" ? receiptCurrent ? "satisfied" : "legacy_unverified" : plan.status === "final_review"
      ? receiptCurrent ? "ready" : "code_review_required" : "not_ready", receipt_current: receiptCurrent,
      unresolved_markers: plan.status === "final_review" ? await this.unresolvedMarkers(workspaceId, plan) : [] };
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
      completed_steps: plan.steps.length, total: plan.steps.length,
      next_action: stale ? "Ask the operator to resolve the stale plan" : "Invoke code-review-and-quality on the cumulative plan delta; the operator finishes the plan after a clean review" };
    const step = plan.steps[plan.current_step]!;
    return { active: (plan.status === "active") as boolean, status: plan.status, guard_status: plan.status === "active" ? await this.guardStatus(workspaceId, integration) : "unavailable", stale,
      stale_reason: stale ? "The memory specification changed after this plan was created; ask the operator to abandon and recreate the plan" : undefined,
      spec_revision: plan.spec_revision, revision: plan.revision, position: plan.current_step + 1, total: plan.steps.length,
      next_action: stale ? "Ask the operator to resolve the stale plan" : plan.status === "active" ? "Work only the current step, then call complete_current" : "Ask the operator to reactivate or abandon the plan",
      step: { id: step.id, kind: step.kind, title: step.title, objective: step.objective, covers: step.covers, writes: step.writes, context: step.context,
        acceptance: step.acceptance, verification: step.verification.map((verification) => ({ id: verification.id, command: verificationCommand(verification), expect_exit: verification.expect_exit, current: verification.verified_generation === step.mutation_generation })),
        mutation_generation: step.mutation_generation, modified_paths: step.modified_paths } };
  }

  async context(workspaceId: string): Promise<string> {
    const current = await this.current(workspaceId);
    if (!("step" in current) || !current.step) return "## ACTIVE PLAN\n\nNone.";
    return ["## ACTIVE PLAN", `Status: ${current.stale ? "STALE" : "active"}; revision ${current.revision}`,
      `Current: ${current.position}/${current.total} — ${current.step.id} ${current.step.title}`,
      `Goal: ${current.step.objective}`, `Write: ${current.step.writes.map((item) => `${item.repo}:${item.path}`).join(", ")}`].join("\n\n");
  }

  async complete(workspaceId: string, allowFinalReview = true) {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || !["active", "final_review"].includes(plan.status)) throw new Error("No active plan");
      if (stale) return { advanced: false, message: "STEP NOT COMPLETE", missing: ["plan is stale because the confirmed spec changed"] };
      if (plan.status === "final_review") {
        if (!allowFinalReview) throw new Error("CODE_REVIEW_REQUIRED: Final plan completion belongs to the operator after the cumulative review gate");
        const gaps: string[] = []; const covered = new Set(plan.steps.flatMap((item) => item.covers));
        const spec = await this.storage.tasks.readStructuredSpec(workspaceId, plan.memory_id);
        for (const requirement of spec?.requirements || []) if (requirement.priority === "must" && !covered.has(requirement.id)
          && !plan.requirement_exceptions.some((item) => item.requirement_id === requirement.id)) gaps.push(`${requirement.id} has no final evidence`);
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
      for (const violation of step.violations) missing.push(`guard violation at ${violation.repo}:${violation.path}: ${violation.reason}`);
      if (step.kind === "implementation" && step.mutation_generation === 0) missing.push("implementation step has no observed content mutation");
      if (step.kind === "implementation") {
        const changed = new Set(step.modified_paths.map((item) => `${item.repo}:${item.path}`));
        for (const write of step.writes) if (!write.not_needed_reason && !changed.has(`${write.repo}:${write.path}`)) missing.push(`${write.repo}:${write.path} has no observed content delta`);
      }
      for (const verification of step.verification) {
        if (verification.verified_generation !== step.mutation_generation || verification.last_exit !== verification.expect_exit) {
          missing.push(`${verificationCommand(verification)} has not passed for mutation generation ${step.mutation_generation}`);
        }
      }
      if (missing.length) return { advanced: false, message: "STEP NOT COMPLETE", missing };
      step.status = "completed"; const completed = plan.current_step;
      if (completed + 1 < plan.steps.length) { plan.current_step += 1; plan.steps[plan.current_step]!.status = "current"; }
      else { plan.status = "final_review"; plan.lifecycle.push({ status: "final_review", at: new Date().toISOString() }); }
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
      return { advanced: true, completed_step: step.id, plan_completed: false, final_review: plan.status === "final_review",
        current_step: plan.status === "active" ? plan.steps[plan.current_step]!.id : undefined };
    });
  }

  async completeCurrent(workspaceId: string) {
    return this.complete(workspaceId, false);
  }

  async reviseCurrentCompact(workspaceId: string, reason: string, input: CompactPlanStep): Promise<PlanState> {
    if (!reason.trim() || reason.trim().length > 2_000) throw new Error("Plan revision requires a bounded reason");
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const memory = await this.active(workspaceId);
      const { plan, stale } = await this.state(workspaceId);
      if (!plan || plan.status !== "active") throw new Error("No active plan");
      if (stale) throw new Error("PLAN_STALE: The memory specification changed; ask the operator to resolve the plan");
      const old = plan.steps[plan.current_step]!;
      const revised = await this.normalizeStep(workspaceId, expandCompactStep(input), "current", old.id);
      const allowed = new Set(revised.writes.map((write) => `${write.repo}:${write.path}`));
      if (old.modified_paths.some((item) => !allowed.has(`${item.repo}:${item.path}`))) throw new Error("Revised current step cannot discard paths already modified");
      revised.modified_paths = old.modified_paths; revised.mutation_generation = old.mutation_generation; revised.violations = old.violations;
      const steps = [...plan.steps]; steps[plan.current_step] = revised;
      await this.assertCoverage(workspaceId, memory.id, steps, plan.requirement_exceptions);
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
    return reviewReceiptCurrent(workspaceId, plan, this.registry);
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
      const future = await Promise.all(futureInputs.map((step, index) => this.normalizeStep(workspaceId, step, "pending", `S${existing.current_step + index + 2}`)));
      existing.steps = [...existing.steps.slice(0, existing.current_step), revisedCurrent, ...future];
      await this.assertCoverage(workspaceId, memory.id, existing.steps, existing.requirement_exceptions);
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
        if (operation.op === "replace_current") plan.steps[plan.current_step] = await this.normalizeStep(workspaceId,
          { ...operation.step, id: plan.steps[plan.current_step]!.id }, "current", plan.steps[plan.current_step]!.id);
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
      await this.assertCoverage(workspaceId, memory.id, plan.steps, plan.requirement_exceptions);
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
      const step = plan.steps[plan.current_step]!; const verification = step.verification.find((item) => verificationCommand(item) === command);
      if (!verification) return false;
      verification.last_exit = exitCode;
      if (exitCode === verification.expect_exit) verification.verified_generation = step.mutation_generation;
      else delete verification.verified_generation;
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan); return true;
    });
  }

  async captureShell(workspaceId: string): Promise<void> {
    await this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) throw new Error("No valid active plan");
      const files: Array<{ repo: string; path: string; hash: string }> = [];
      const workspace = await this.registry.get(workspaceId);
      for (const repository of workspace.repositories) for (const relative of await walkReadableFiles(repository.path)) {
        const hash = await contentHash(path.join(repository.path, relative)); if (hash) files.push({ repo: repository.id, path: relative, hash });
      }
      plan.steps[plan.current_step]!.pending_shell = { files };
      plan.updated_at = new Date().toISOString(); await this.storage.write(workspaceId, plan);
    });
  }

  async recordShell(workspaceId: string, command: string, exitCode: number): Promise<{ verified: boolean; changed: string[]; violations: string[] }> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const { plan, stale } = await this.state(workspaceId); if (!plan || plan.status !== "active" || stale) return { verified: false, changed: [], violations: [] };
      const step = plan.steps[plan.current_step]!; const before = new Map((step.pending_shell?.files || []).map((item) => [`${item.repo}:${item.path}`, item.hash]));
      delete step.pending_shell; const after = new Map<string, string>(); const workspace = await this.registry.get(workspaceId);
      for (const repository of workspace.repositories) for (const relative of await walkReadableFiles(repository.path)) {
        const hash = await contentHash(path.join(repository.path, relative)); if (hash) after.set(`${repository.id}:${relative}`, hash);
      }
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
      const allowed = new Set(step.writes.map((item) => `${item.repo}:${item.path}`)); const violations = changed.filter((item) => !allowed.has(item));
      const now = new Date().toISOString();
      for (const item of violations) { const [repo, ...parts] = item.split(":"); step.violations.push({ repo: repo!, path: parts.join(":"), reason: "shell changed a path outside the current write-set", at: now }); }
      const authorized = changed.filter((item) => allowed.has(item));
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
        const verification = step.verification.find((item) => verificationCommand(item) === command.trim());
        if (verification) { verification.last_exit = exitCode; if (exitCode === verification.expect_exit) { verification.verified_generation = step.mutation_generation; verified = true; } else delete verification.verified_generation; }
      }
      plan.updated_at = now; await this.storage.write(workspaceId, plan); return { verified, changed, violations };
    });
  }

  async transition(workspaceId: string, status: "suspended" | "active" | "abandoned", reason?: string): Promise<PlanState> {
    const memory = await this.active(workspaceId);
    return this.transitionForMemory(workspaceId, memory.id, status, reason);
  }

  async transitionForMemory(workspaceId: string, memoryId: string, status: "suspended" | "active" | "abandoned", reason?: string): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const plan = await this.storage.read(workspaceId, memoryId);
      if (!plan || ["completed", "abandoned"].includes(plan.status)) throw new Error("No non-terminal plan");
      if (status === "active" && plan.status !== "suspended") throw new Error("Only a suspended plan can be reactivated");
      if (status === "suspended" && plan.status !== "active") throw new Error("Only an active plan can be suspended");
      if (status === "abandoned" && !reason?.trim()) throw new Error("Abandoning a plan requires a reason");
      if (status === "active") {
        if (plan.archived_at) throw new Error("Restore this archived plan before reactivating it");
        const selected = await this.tasks.current(workspaceId);
        if (selected?.id !== memoryId) throw new Error("Select this memory as active before reactivating its plan");
        if ((await this.stateForMemory(workspaceId, memoryId)).stale) throw new Error("PLAN_STALE: Abandon and recreate this plan against the current spec");
      }
      plan.status = status; plan.updated_at = new Date().toISOString();
      plan.lifecycle = [...plan.lifecycle, { status, reason: reason?.trim(), at: plan.updated_at }].slice(-50);
      await this.storage.write(workspaceId, plan); return plan;
    });
  }

  async setArchived(workspaceId: string, memoryId: string, archived: boolean): Promise<PlanState> {
    return this.storage.tasks.workspaceLock(workspaceId, async () => {
      const plan = await this.storage.read(workspaceId, memoryId);
      if (!plan) throw new Error("No plan for this memory");
      if (archived && ["active", "final_review"].includes(plan.status)) throw new Error("Suspend or abandon the active plan before archiving it");
      if (archived) plan.archived_at = new Date().toISOString(); else delete plan.archived_at;
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
