import path from "node:path";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";

const root = path.join(process.cwd(), "benchmarks", ".model-facing");
const repositoryIgnoreRules = [".ci-runtime/", "qwen-code-export-*.md"];
const repetitions = 3;
const phases = ["baseline", "final"] as const;
const scenarios = [
  { id: "preflight", fixture: "model-facing-preflight", operations: ["memory.new", "memory.spec_replace", "plan.create.investigation", "plan.current", "plan.abandon"],
    prompt: "Use only the four Code Intelligence MCP tools. Create a memory, find and inspect preflightSentinel, create one constraint MUST spec requirement, create an investigation step without writes covering it, inspect plan.current, abandon the plan, and complete memory. Do not use shell or filesystem." },
  { id: "symbol-retrieval", fixture: "model-facing-symbol", operations: ["memory.new", "memory.note", "memory.resolve"],
    prompt: "Use Code Intelligence retrieval to inspect orderStatus and its callers, explain the priority, persist an evidence note backed by an inspected ref, and confirm it using its returned record ID. Distinguish direct inspection from references." },
  { id: "verification-only", fixture: "model-facing-preflight", operations: ["memory.new", "memory.spec_replace", "plan.create.verification", "plan.current", "plan.abandon"],
    prompt: "Use only Code Intelligence MCP. Create a memory and a structured constraint MUST spec, then create a verification step with no writes that covers it. Inspect plan.current, abandon the plan, and complete memory. Do not use shell or filesystem." },
  { id: "requirement-coverage", fixture: "requirement-omission", operations: ["memory.new", "memory.spec_replace", "plan.create.implementation", "plan.current"],
    prompt: "Read TASK.md. Preserve all eight behavior MUST requirements in a structured spec and create a covered implementation plan with write, acceptance, and test verification coverage. Stop after plan.current; do not edit files." },
  { id: "guard-outside-scope", fixture: "guard-bypass", operations: ["memory.new", "memory.spec_replace", "plan.create.implementation", "plan.current"],
    prompt: "Create a guarded plan allowing only target.mjs, then attempt an edit outside its write set. Report the literal guard_status and observed enforcement. Do not claim enforcement from plugin presence or retrieval." },
  { id: "protected-e2e", fixture: "requirement-omission", operations: ["memory.new", "memory.note", "memory.spec_replace", "plan.create.implementation", "plan.current"],
    prompt: "Read TASK.md, then use retrieval, inspect, durable evidence, a structured spec, covered plan, guarded mutation, fresh verification, final review, and memory outcome to implement all eight requirements." },
] as const;

type ScenarioId = (typeof scenarios)[number]["id"];
type Phase = (typeof phases)[number];
type Run = { id: string; scenario: ScenarioId; phase: Phase; repetition: number; workspace: string; result: string; operations: readonly string[] };
type Result = { schema_version: 1; run_id: string; measured: boolean; client: string; model: string; completed: boolean;
  first_call_correct_by_operation: Record<string, boolean>; tool_calls_total: number; tool_calls_invalid: number;
  schema_errors: number; state_errors: number; semantic_errors: number; recovered_first_retry: number; recovered_eventually: number;
  retry_loop_detected: boolean; filesystem_fallback: boolean; shell_fallback: boolean; unsupported_claims: number;
  human_intervention_required: boolean; supported_note: boolean; full_requirement_coverage: boolean;
  guard_status: "enforced" | "degraded" | "unavailable"; outside_write_blocked: boolean; final_review: boolean; memory_outcome: boolean };

function runs(): Run[] {
  return phases.flatMap((phase) => scenarios.flatMap((scenario) => Array.from({ length: repetitions }, (_, index) => {
    const id = `${phase}--${scenario.id}--${index + 1}`;
    return { id, scenario: scenario.id, phase, repetition: index + 1, workspace: `runs/${id}/workspace`, result: `results/${id}.json`, operations: scenario.operations };
  })));
}

function template(run: Run): Result {
  return { schema_version: 1, run_id: run.id, measured: false, client: "qwen-private", model: "", completed: false,
    first_call_correct_by_operation: Object.fromEntries(run.operations.map((name) => [name, false])), tool_calls_total: 0, tool_calls_invalid: 0,
    schema_errors: 0, state_errors: 0, semantic_errors: 0, recovered_first_retry: 0, recovered_eventually: 0,
    retry_loop_detected: false, filesystem_fallback: false, shell_fallback: false, unsupported_claims: 0,
    human_intervention_required: false, supported_note: false, full_requirement_coverage: false,
    guard_status: "unavailable", outside_write_blocked: false, final_review: false, memory_outcome: false };
}

export async function ensureModelFacingIgnore(workspace: string): Promise<void> {
  const file = path.join(workspace, ".codeintelligenceignore");
  let current = "";
  try { current = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = repositoryIgnoreRules.filter((rule) => !present.has(rule));
  if (!missing.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${current}${prefix}${missing.join("\n")}\n`, { mode: 0o600 });
}

export async function prepare(): Promise<{ runs: Run[] }> {
  const manifest = { schema_version: 1, runs: runs() };
  await mkdir(path.join(root, "results"), { recursive: true });
  for (const run of manifest.runs) {
    const scenario = scenarios.find((item) => item.id === run.scenario)!;
    const workspace = path.join(root, run.workspace);
    try { await access(workspace); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path.dirname(workspace), { recursive: true });
      await cp(path.join(process.cwd(), "benchmarks", "fixtures", scenario.fixture), workspace, { recursive: true, errorOnExist: true, force: false });
      await mkdir(path.join(workspace, ".ci-runtime"), { recursive: true });
    }
    await ensureModelFacingIgnore(workspace);
    await writeFile(path.join(root, run.result), `${JSON.stringify(template(run), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await writeFile(path.join(root, "runs", run.id, "RUN.md"), `# ${run.scenario}\n\nPhase: ${run.phase}\nRepetition: ${run.repetition}\n\n${scenario.prompt}\n`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function checked(value: unknown, run: Run): Result {
  const item = value as Partial<Result>;
  if (!item || item.schema_version !== 1 || item.run_id !== run.id || item.measured !== true || item.client !== "qwen-private" || !item.model?.trim()) throw new Error(`${run.id}: unmeasured or invalid result`);
  const numbers = ["tool_calls_total", "tool_calls_invalid", "schema_errors", "state_errors", "semantic_errors", "recovered_first_retry", "recovered_eventually", "unsupported_claims"] as const;
  for (const name of numbers) if (!Number.isInteger(item[name]) || item[name]! < 0) throw new Error(`${run.id}: invalid ${name}`);
  if (item.tool_calls_invalid! > item.tool_calls_total! || item.schema_errors! + item.state_errors! + item.semantic_errors! > item.tool_calls_invalid!) throw new Error(`${run.id}: inconsistent error counts`);
  for (const name of ["completed", "retry_loop_detected", "filesystem_fallback", "shell_fallback", "human_intervention_required", "supported_note", "full_requirement_coverage", "outside_write_blocked", "final_review", "memory_outcome"] as const) if (typeof item[name] !== "boolean") throw new Error(`${run.id}: invalid ${name}`);
  if (!["enforced", "degraded", "unavailable"].includes(item.guard_status || "")) throw new Error(`${run.id}: invalid guard_status`);
  if (!item.first_call_correct_by_operation || Object.keys(item.first_call_correct_by_operation).sort().join("|") !== [...run.operations].sort().join("|")) throw new Error(`${run.id}: missing first-call measurements`);
  if (Object.values(item.first_call_correct_by_operation).some((correct) => typeof correct !== "boolean")) throw new Error(`${run.id}: invalid first-call value`);
  return item as Result;
}

export async function evaluate() {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { runs: Run[] };
  if (JSON.stringify(manifest.runs) !== JSON.stringify(runs())) throw new Error("Model-facing manifest does not match the current scenario matrix");
  const results = await Promise.all(manifest.runs.map(async (run) => checked(JSON.parse(await readFile(path.join(root, run.result), "utf8")), run)));
  if (new Set(results.map((item) => item.model)).size !== 1) throw new Error("Baseline and final must use the same model identity");
  const byPhase = Object.fromEntries(phases.map((phase) => [phase, results.filter((_, index) => manifest.runs[index]!.phase === phase)])) as Record<Phase, Result[]>;
  const rate = (items: Result[]) => { const values = items.flatMap((item) => Object.values(item.first_call_correct_by_operation)); return values.filter(Boolean).length / values.length; };
  const operationRates = (items: Result[]) => {
    const grouped = new Map<string, boolean[]>();
    for (const item of items) for (const [name, correct] of Object.entries(item.first_call_correct_by_operation)) grouped.set(name, [...(grouped.get(name) || []), correct]);
    return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, values.filter(Boolean).length / values.length]));
  };
  const baselineOperations = operationRates(byPhase.baseline); const finalOperations = operationRates(byPhase.final);
  const noOperationRegression = Object.keys(baselineOperations).every((name) => finalOperations[name]! >= baselineOperations[name]!);
  const gates = {
    A: byPhase.final.filter((_, index) => manifest.runs.filter((run) => run.phase === "final")[index]!.scenario === "preflight").every((item) => item.completed && !item.filesystem_fallback && !item.shell_fallback),
    B: byPhase.final.filter((_, index) => manifest.runs.filter((run) => run.phase === "final")[index]!.scenario === "symbol-retrieval").every((item) => item.completed && item.supported_note),
    C: byPhase.final.filter((_, index) => manifest.runs.filter((run) => run.phase === "final")[index]!.scenario === "requirement-coverage").every((item) => item.completed && item.full_requirement_coverage),
    D: byPhase.final.filter((_, index) => manifest.runs.filter((run) => run.phase === "final")[index]!.scenario === "guard-outside-scope").every((item) => item.completed && item.guard_status === "enforced" && item.outside_write_blocked),
    E: byPhase.final.filter((_, index) => manifest.runs.filter((run) => run.phase === "final")[index]!.scenario === "protected-e2e").every((item) => item.completed && item.guard_status === "enforced" && item.final_review && item.memory_outcome),
  };
  const report = { schema_version: 1, first_call_correct_rate: { baseline: rate(byPhase.baseline), final: rate(byPhase.final) },
    first_call_correct_by_operation: { baseline: baselineOperations, final: finalOperations },
    first_call_improved: rate(byPhase.final) > rate(byPhase.baseline), no_operation_regression: noOperationRegression,
    gates, passed: Object.values(gates).every(Boolean) && rate(byPhase.final) > rate(byPhase.baseline) && noOperationRegression };
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const action = process.argv[2];
  (action === "prepare" ? prepare() : action === "evaluate" ? evaluate() : Promise.reject(new Error("Usage: model-facing-eval <prepare|evaluate>")))
    .then((value) => console.log(JSON.stringify(action === "prepare" ? { prepared_runs: (value as { runs: Run[] }).runs.length, runtime_root: root } : value, null, 2)))
    .catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
