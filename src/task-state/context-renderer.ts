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
  let text = [
    "## MEMORY",
    `Work: ${bootstrap.title} (${bootstrap.id}, ${bootstrap.status})`,
    `Objective: ${bootstrap.objective || "Not set"}`,
    `Phase: ${bootstrap.phase}`,
    bootstrap.confirmed_findings.length ? `Confirmed findings:\n${bootstrap.confirmed_findings.map((v) => `- ${v}`).join("\n")}` : "",
    bootstrap.active_hypotheses.length ? `Active hypotheses:\n${bootstrap.active_hypotheses.map((v) => `- [${v.confidence}] ${v.text}`).join("\n")}` : "",
    bootstrap.open_questions.length ? `Open questions:\n${bootstrap.open_questions.map((v) => `- ${v}`).join("\n")}` : "",
    bootstrap.blockers.length ? `Blockers:\n${bootstrap.blockers.map((v) => `- ${v}`).join("\n")}` : "",
    bootstrap.relevant_files.length ? `Relevant files:\n${bootstrap.relevant_files.map((v) => `- ${v.repo}:${v.path}`).join("\n")}` : "",
    bootstrap.relevant_symbols.length ? `Relevant symbols: ${bootstrap.relevant_symbols.join(", ")}` : "",
    bootstrap.inspected_commits.length ? `Recently inspected commits: ${bootstrap.inspected_commits.map((v) => `${v.repo}:${v.commit}`).join(", ")}` : "",
    bootstrap.inspected_refs.length ? `Recently inspected refs: ${bootstrap.inspected_refs.join(", ")}` : "",
    `Detailed findings: ${findingsPath}`,
    `Confirmed spec: ${specPath}`,
  ].filter(Boolean).join("\n\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 34)}\n… [memory context truncated]`;
  return text;
}
