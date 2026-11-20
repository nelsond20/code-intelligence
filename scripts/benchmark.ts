import path from "node:path";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";

type Phase = "baseline" | "final";
interface Scenario { id: string; title: string; fixture: string; prompt: string; focus: string[] }
interface ScenarioFile { schema_version: 1; repetitions: number; phases: Phase[]; scenarios: Scenario[] }
interface Run { run_id: string; phase: Phase; repetition: number; scenario_id: string; title: string; prompt: string; focus: string[]; fixture_path: string; result_path: string }
interface Manifest { schema_version: 1; generated_at: string; expected_runs: number; runs: Run[] }
interface Result {
  schema_version: 1; run_id: string; measured: boolean; completed: boolean;
  must_requirements_total: number; must_requirements_with_evidence: number;
  outside_plan_files: number; no_delta_steps: number;
  required_tests_total: number; required_tests_after_last_mutation: number;
  repeated_searches_after_compaction: number;
  tool_calls: number; tool_call_errors: number;
  degraded_recovery_attempts: number; degraded_recoveries: number;
  memory_facts_total: number; memory_facts_current: number;
  tokens_to_symbol?: number; milliseconds_to_symbol?: number; notes?: string;
}

const projectRoot = process.cwd();
const scenarioPath = path.join(projectRoot, "benchmarks", "scenarios.json");
const runtimeRoot = path.join(projectRoot, "benchmarks", ".runtime");
const manifestPath = path.join(runtimeRoot, "manifest.json");

async function loadScenarios(): Promise<ScenarioFile> {
  const parsed = JSON.parse(await readFile(scenarioPath, "utf8")) as ScenarioFile;
  if (parsed.schema_version !== 1 || !Number.isInteger(parsed.repetitions) || parsed.repetitions < 1) throw new Error("Invalid benchmark scenario schema");
  if (new Set(parsed.scenarios.map((item) => item.id)).size !== parsed.scenarios.length) throw new Error("Benchmark scenario IDs must be unique");
  if (parsed.phases.length !== 2 || !parsed.phases.includes("baseline") || !parsed.phases.includes("final")) throw new Error("Benchmark requires baseline and final phases");
  return parsed;
}

function template(run: Run): Result {
  return { schema_version: 1, run_id: run.run_id, measured: false, completed: false,
    must_requirements_total: 0, must_requirements_with_evidence: 0,
    outside_plan_files: 0, no_delta_steps: 0,
    required_tests_total: 0, required_tests_after_last_mutation: 0,
    repeated_searches_after_compaction: 0, tool_calls: 0, tool_call_errors: 0,
    degraded_recovery_attempts: 0, degraded_recoveries: 0,
    memory_facts_total: 0, memory_facts_current: 0,
    notes: "Replace this template with measurements from the explicitly approved model run." };
}

export async function prepare(): Promise<Manifest> {
  const definitions = await loadScenarios(); const runs: Run[] = [];
  for (const phase of definitions.phases) for (const scenario of definitions.scenarios) for (let repetition = 1; repetition <= definitions.repetitions; repetition += 1) {
    const run_id = `${phase}--${scenario.id}--${repetition}`;
    runs.push({ run_id, phase, repetition, scenario_id: scenario.id, title: scenario.title, prompt: scenario.prompt,
      focus: scenario.focus, fixture_path: `runs/${run_id}/workspace`, result_path: `results/${run_id}.json` });
  }
  const manifest: Manifest = { schema_version: 1, generated_at: new Date().toISOString(), expected_runs: runs.length, runs };
  await mkdir(path.join(runtimeRoot, "results"), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  for (const run of runs) {
    const scenario = definitions.scenarios.find((item) => item.id === run.scenario_id)!; const fixtureTarget = path.join(runtimeRoot, run.fixture_path);
    try { await access(fixtureTarget); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path.dirname(fixtureTarget), { recursive: true }); await cp(path.join(projectRoot, scenario.fixture), fixtureTarget, { recursive: true, errorOnExist: true, force: false });
    }
    await writeFile(path.join(runtimeRoot, run.result_path), `${JSON.stringify(template(run), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeFile(path.join(runtimeRoot, "runs", run.run_id, "RUN.md"), `# ${run.title}\n\nPhase: ${run.phase}\nRepetition: ${run.repetition}\n\n${run.prompt}\n`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return manifest;
}

function finiteNonNegative(value: unknown, field: string, runId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${runId}: ${field} must be a finite non-negative number`);
  return value;
}

function validateResult(value: unknown, run: Run): Result {
  if (!value || typeof value !== "object") throw new Error(`${run.run_id}: result must be an object`);
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 1 || item.run_id !== run.run_id || item.measured !== true || typeof item.completed !== "boolean") throw new Error(`${run.run_id}: result is still a template or has invalid identity/schema fields`);
  for (const field of ["must_requirements_total", "must_requirements_with_evidence", "outside_plan_files", "no_delta_steps", "required_tests_total",
    "required_tests_after_last_mutation", "repeated_searches_after_compaction", "tool_calls", "tool_call_errors", "degraded_recovery_attempts",
    "degraded_recoveries", "memory_facts_total", "memory_facts_current"]) finiteNonNegative(item[field], field, run.run_id);
  const result = item as unknown as Result;
  if (result.must_requirements_with_evidence > result.must_requirements_total) throw new Error(`${run.run_id}: must evidence exceeds total`);
  if (result.required_tests_after_last_mutation > result.required_tests_total) throw new Error(`${run.run_id}: executed tests exceed total`);
  if (result.tool_call_errors > result.tool_calls) throw new Error(`${run.run_id}: tool errors exceed calls`);
  if (result.degraded_recoveries > result.degraded_recovery_attempts) throw new Error(`${run.run_id}: recoveries exceed attempts`);
  if (result.memory_facts_current > result.memory_facts_total) throw new Error(`${run.run_id}: current facts exceed total`);
  return result;
}

function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 1 : numerator / denominator; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }

function metrics(results: Result[]) {
  const sum = (field: keyof Result) => results.reduce((total, item) => total + (typeof item[field] === "number" ? item[field] as number : 0), 0);
  const averageOptional = (field: "tokens_to_symbol" | "milliseconds_to_symbol") => {
    const values = results.flatMap((item) => typeof item[field] === "number" ? [item[field]!] : []);
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };
  return {
    runs: results.length,
    completion_rate: round(results.filter((item) => item.completed).length / Math.max(1, results.length)),
    must_evidence_rate: round(ratio(sum("must_requirements_with_evidence"), sum("must_requirements_total"))),
    outside_plan_files: sum("outside_plan_files"), no_delta_steps: sum("no_delta_steps"),
    post_mutation_test_rate: round(ratio(sum("required_tests_after_last_mutation"), sum("required_tests_total"))),
    repeated_searches_after_compaction: sum("repeated_searches_after_compaction"),
    tool_call_error_rate: round(ratio(sum("tool_call_errors"), sum("tool_calls"))),
    degraded_recovery_rate: round(ratio(sum("degraded_recoveries"), sum("degraded_recovery_attempts"))),
    memory_precision: round(ratio(sum("memory_facts_current"), sum("memory_facts_total"))),
    average_tokens_to_symbol: averageOptional("tokens_to_symbol"), average_milliseconds_to_symbol: averageOptional("milliseconds_to_symbol"),
  };
}

export async function evaluate(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const byPhase: Record<Phase, Result[]> = { baseline: [], final: [] }; const missing: string[] = [];
  for (const run of manifest.runs) {
    try { byPhase[run.phase].push(validateResult(JSON.parse(await readFile(path.join(runtimeRoot, run.result_path), "utf8")), run)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(run.run_id); else throw error; }
  }
  if (missing.length) throw new Error(`Missing benchmark results: ${missing.join(", ")}`);
  const baseline = metrics(byPhase.baseline); const final = metrics(byPhase.final);
  const gates = {
    all_runs_present: byPhase.baseline.length + byPhase.final.length === manifest.expected_runs,
    completion_not_regressed: final.completion_rate >= baseline.completion_rate,
    must_coverage_not_regressed: final.must_evidence_rate >= baseline.must_evidence_rate,
    zero_outside_plan_writes: final.outside_plan_files === 0,
    zero_no_delta_steps: final.no_delta_steps === 0,
    post_mutation_tests_not_regressed: final.post_mutation_test_rate >= baseline.post_mutation_test_rate,
    tool_errors_not_regressed: final.tool_call_error_rate <= baseline.tool_call_error_rate,
    degraded_recovery_not_regressed: final.degraded_recovery_rate >= baseline.degraded_recovery_rate,
    memory_precision_not_regressed: final.memory_precision >= baseline.memory_precision,
  };
  const report = { schema_version: 1, evaluated_at: new Date().toISOString(), expected_runs: manifest.expected_runs,
    baseline, final, gates, passed: Object.values(gates).every(Boolean) };
  await writeFile(path.join(runtimeRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const markdown = [`# Benchmark report`, ``, `Expected runs: ${manifest.expected_runs}`, `Overall: ${report.passed ? "PASS" : "FAIL"}`, ``,
    `| Metric | Baseline | Final |`, `| --- | ---: | ---: |`,
    ...Object.keys(baseline).map((key) => `| ${key} | ${String(baseline[key as keyof typeof baseline])} | ${String(final[key as keyof typeof final])} |`),
    ``, `## Gates`, ``, ...Object.entries(gates).map(([key, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${key}`), ``].join("\n");
  await writeFile(path.join(runtimeRoot, "report.md"), markdown, { mode: 0o600 });
  return report;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare") console.log(JSON.stringify(await prepare(), null, 2));
  else if (command === "evaluate") console.log(JSON.stringify(await evaluate(), null, 2));
  else throw new Error("Usage: benchmark <prepare|evaluate>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
