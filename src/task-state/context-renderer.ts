import type { TaskState } from "./schemas.js";

function compactList(values: string[], max = 12): string[] { return values.slice(0, max); }

export function taskBootstrap(state: TaskState, findingsPath: string, specPath: string) {
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    objective: state.objective,
    phase: state.phase,
    confirmed_findings: compactList(state.confirmed_findings),
    active_hypotheses: state.active_hypotheses.slice(0, 10),
    open_questions: compactList(state.open_questions),
    blockers: compactList(state.blockers),
    relevant_files: state.relevant_files.slice(0, 20),
    relevant_symbols: compactList(state.relevant_symbols, 20),
    inspected_refs: compactList(state.inspected_refs, 15),
    inspected_commits: state.inspected_commits.slice(0, 10),
    findings_path: findingsPath,
    spec_path: specPath,
    updated_at: state.updated_at,
  };
}

export function renderTaskContext(state: TaskState, findingsPath: string, specPath: string, maxTokens = 3000): string {
  const maxChars = Math.max(400, maxTokens * 4);
  const bootstrap = taskBootstrap(state, findingsPath, specPath);
  const required = ["## MEMORY",
    `Work: ${bootstrap.title} (${bootstrap.id}, ${bootstrap.status})`,
    `Objective: ${bootstrap.objective || "Not set"}`,
    `Phase: ${bootstrap.phase}`,
    `For full records and the structured spec, call memory.read with id ${bootstrap.id}.`,
  ];
  const optional = [
    ...bootstrap.blockers.map((v) => `Blocker: ${v}`),
    ...bootstrap.open_questions.map((v) => `Open question: ${v}`),
    ...bootstrap.confirmed_findings.map((v) => `Confirmed: ${v}`),
    ...bootstrap.active_hypotheses.map((v) => `Hypothesis [${v.confidence}]: ${v.text}`),
    ...bootstrap.relevant_files.map((v) => `Relevant file: ${v.repo}:${v.path}`),
    ...bootstrap.relevant_symbols.map((v) => `Relevant symbol: ${v}`),
    ...bootstrap.inspected_commits.map((v) => `Inspected commit: ${v.repo}:${v.commit}`),
    ...bootstrap.inspected_refs.map((v) => `Inspected ref: ${v}`),
  ];
  const sections = [...required]; let truncated = false;
  for (const item of optional) {
    if ([...sections, item].join("\n\n").length > maxChars - 40) { truncated = true; break; }
    sections.push(item);
  }
  if (truncated) sections.push("… [additional memory items omitted]");
  return sections.join("\n\n");
}
