import type { TaskState } from "./schemas.js";

/** Current presentation only. Historical records remain in records. */
export function currentFindings(state: TaskState, status: "supported" | "confirmed"): string[] {
  const seen = new Set<string>();
  return state.records.filter((record) => !record.archived_at
    && ["observation", "evidence", "decision", "hypothesis"].includes(record.kind)
    && record.status === status
    && record.evidence_refs.length > 0)
    .map((record) => record.text)
    .filter((text) => { if (seen.has(text)) return false; seen.add(text); return true; })
    .slice(0, 50);
}

export function currentConfirmedFindings(state: TaskState): string[] { return currentFindings(state, "confirmed"); }

export function projectTaskState(state: TaskState): TaskState {
  const active = state.records.filter((record) => !record.archived_at && ["observed", "supported", "confirmed"].includes(record.status));
  const rejected = state.records.filter((record) => !record.archived_at && record.kind === "hypothesis"
    && ["rejected", "superseded", "ruled_out"].includes(record.status));
  return { ...state, confirmed_findings: currentConfirmedFindings(state), supported_findings: currentFindings(state, "supported"),
    active_hypotheses: active.filter((record) => record.kind === "hypothesis").slice(0, 30)
      .map((record) => ({ id: record.id, text: record.text, confidence: record.confidence })),
    rejected_hypotheses: rejected.map((record) => ({ id: record.id, text: record.text, confidence: record.confidence, reason: record.reason })),
    open_questions: active.filter((record) => record.kind === "question").map((record) => record.text).slice(0, 50),
    blockers: active.filter((record) => record.kind === "blocker").map((record) => record.text).slice(0, 50) };
}
