import path from "node:path";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";

const root = path.join(process.cwd(), "benchmarks", ".memory-control-v1");
const runId = "memory-control-v1--preflight--1";
const prompt = "Use only the four Code Intelligence MCP tools. A work memory has already been selected by the operator. Inspect preflightSentinel, record an evidence note backed by the inspected ref, confirm that note using its returned record ID, and establish one structured constraint MUST requirement about the sentinel. Then inspect the current memory and report what you found. Do not use shell or filesystem.";
const operations = ["memory.current", "memory.spec_set", "memory.note", "memory.resolve"];

type Result = { schema_version: 1; benchmark_version: "memory-control-v1"; run_id: string; measured: boolean;
  client: string; model: string; first_call_correct_by_operation: Record<string, boolean>;
  tool_search_used: boolean; shell_used: boolean; filesystem_used: boolean; cross_memory_access: boolean;
  completed: boolean; notes?: string };

export async function prepareMemoryControlEval() {
  const workspace = path.join(root, "runs", runId, "workspace");
  await mkdir(path.dirname(workspace), { recursive: true });
  try { await access(workspace); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await cp(path.join(process.cwd(), "benchmarks", "fixtures", "model-facing-preflight"), workspace, { recursive: true, errorOnExist: true, force: false });
  }
  await mkdir(path.join(workspace, ".ci-runtime"), { recursive: true });
  await writeFile(path.join(workspace, ".codeintelligenceignore"), ".ci-runtime/\nqwen-code-export-*.md\n", { flag: "wx", mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const instructions = `# Memory control v1 — preflight\n\nThis is a new benchmark version for the 0.3 memory contract. Do not overwrite or reinterpret final--preflight--3 or the earlier 0.2 evidence.\n\nBefore presenting the prompt, register this isolated workspace, start the 0.3 MCP server, create a paused memory through the control plane, and explicitly select it as active. Capture the first call for each measured operation. The exact prompt below deliberately does not name spec_set.\n\n## Prompt\n\n${prompt}\n\n## Results\n\nWrite only observed booleans to results/${runId}.json. Keep model, provider, quantization, and sampling details in the local evaluation record. Do not place exports or transcripts in the workspace.\n`;
  await writeFile(path.join(root, "runs", runId, "RUN.md"), instructions, { flag: "wx", mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await mkdir(path.join(root, "results"), { recursive: true });
  const template: Result = { schema_version: 1, benchmark_version: "memory-control-v1", run_id: runId, measured: false,
    client: "qwen-private", model: "", first_call_correct_by_operation: Object.fromEntries(operations.map((name) => [name, false])),
    tool_search_used: false, shell_used: false, filesystem_used: false, cross_memory_access: false, completed: false };
  await writeFile(path.join(root, "results", `${runId}.json`), `${JSON.stringify(template, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  return { benchmark_version: "memory-control-v1", run_id: runId, workspace, prompt_file: path.join(root, "runs", runId, "RUN.md") };
}

export async function evaluateMemoryControlEval() {
  const result = JSON.parse(await readFile(path.join(root, "results", `${runId}.json`), "utf8")) as Result;
  if (result.schema_version !== 1 || result.benchmark_version !== "memory-control-v1" || result.run_id !== runId ||
      result.measured !== true || result.client !== "qwen-private" || !result.model?.trim()) throw new Error("Unmeasured or invalid memory-control result");
  if (Object.keys(result.first_call_correct_by_operation || {}).sort().join("|") !== [...operations].sort().join("|") ||
      Object.values(result.first_call_correct_by_operation).some((value) => typeof value !== "boolean")) throw new Error("Incomplete first-call evidence");
  for (const key of ["tool_search_used", "shell_used", "filesystem_used", "cross_memory_access", "completed"] as const)
    if (typeof result[key] !== "boolean") throw new Error(`Invalid ${key}`);
  const passed = result.completed && Object.values(result.first_call_correct_by_operation).every(Boolean) &&
    !result.tool_search_used && !result.shell_used && !result.filesystem_used && !result.cross_memory_access;
  const report = { benchmark_version: "memory-control-v1", run_id: runId, passed, first_call_correct_by_operation: result.first_call_correct_by_operation,
    tool_search_used: result.tool_search_used, shell_used: result.shell_used, filesystem_used: result.filesystem_used, cross_memory_access: result.cross_memory_access };
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1]?.endsWith("/memory-control-eval.js")) {
  const action = process.argv[2];
  (action === "prepare" ? prepareMemoryControlEval() : action === "evaluate" ? evaluateMemoryControlEval() : Promise.reject(new Error("Usage: memory-control-eval <prepare|evaluate>")))
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
