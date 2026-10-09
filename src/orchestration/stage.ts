import { PlanService } from "../plan/service.js";

export type WorkflowStage = "operator_action_required" | "investigation" | "specification" | "planning" | "implementation" | "final_review" | "completed";
export interface StageGuidance { stage: WorkflowStage; required_skill: string | null; next_action: string; }
export type MemoryAction = "current" | "note" | "resolve" | "spec_set";

// The stage is derived from persisted memory/spec/plan state, never from tool input.
const memoryActionsByStage: Record<WorkflowStage, readonly MemoryAction[]> = {
  operator_action_required: ["current"],
  // Existing direct spec authoring permits a validated investigation -> planning transition.
  investigation: ["current", "note", "resolve", "spec_set"],
  specification: ["current", "spec_set"],
  planning: ["current"],
  implementation: ["current"],
  final_review: ["current"],
  completed: ["current"],
};

export class StageActionError extends Error {
  readonly code = "ACTION_NOT_ALLOWED_IN_STAGE";
  constructor(readonly action: MemoryAction, readonly guidance: StageGuidance) {
    super(`memory.${action} is not allowed while stage=${guidance.stage}.`);
  }
}

export function assertMemoryActionAllowed(action: MemoryAction, stage: StageGuidance): void {
  if (!memoryActionsByStage[stage.stage].includes(action)) throw new StageActionError(action, stage);
}

const guidance: Record<WorkflowStage, StageGuidance> = {
  operator_action_required: { stage: "operator_action_required", required_skill: null, next_action: "Ask the operator to select or resolve the active memory and plan in the control plane." },
  investigation: { stage: "investigation", required_skill: "code-intelligence-investigation", next_action: "Continue investigation and persist supported findings." },
  specification: { stage: "specification", required_skill: "code-intelligence-specification", next_action: "Set the complete structured specification with memory.spec_set." },
  planning: { stage: "planning", required_skill: "code-intelligence-planning", next_action: "Create the persistent Code Intelligence plan with plan.create, then confirm plan.current." },
  implementation: { stage: "implementation", required_skill: "code-intelligence-implementation", next_action: "Load plan.current and work only the server-selected current step." },
  final_review: { stage: "final_review", required_skill: "code-review-and-quality", next_action: "Review the cumulative plan delta and obtain a valid external review receipt before operator completion." },
  completed: { stage: "completed", required_skill: null, next_action: "The plan is complete; the operator controls memory lifecycle." },
};

export async function deriveStage(plans: PlanService, workspaceId: string): Promise<StageGuidance> {
  const memory = await plans.tasks.current(workspaceId);
  if (!memory) return guidance.operator_action_required;
  const planState = await plans.stateForMemory(workspaceId, memory.id);
  const plan = planState.plan?.archived_at ? undefined : planState.plan;
  const stale = planState.stale;
  if (plan && !["completed", "abandoned"].includes(plan.status)) {
    if (stale || plan.status === "suspended") return { ...guidance.operator_action_required,
      next_action: stale ? "Ask the operator to resolve the stale plan before implementation." : "Ask the operator to reactivate or abandon the suspended plan." };
    if (plan.status === "final_review") return guidance.final_review;
    if (plan.status === "active" && plan.steps[plan.current_step]?.status === "current") return guidance.implementation;
    return guidance.operator_action_required;
  }
  const spec = memory.spec_archived_at ? undefined : await plans.storage.tasks.readStructuredSpec(workspaceId, memory.id);
  if (plan?.status === "completed" && !stale) return guidance.completed;
  if (spec) return guidance.planning;
  // A confirmed investigation decision is durable evidence of readiness; the
  // free-form human phase is metadata, not a stage flag.
  const ready = memory.open_questions.length === 0 && memory.blockers.length === 0
    && memory.records.some((record) => ["observation", "evidence"].includes(record.kind)
      && ["supported", "confirmed"].includes(record.status) && record.evidence_refs.length > 0
      && record.evidence_refs.every((ref) => memory.inspected_refs.includes(ref)))
    && memory.records.some((record) => record.kind === "decision" && record.status === "confirmed"
      && record.evidence_refs.length > 0 && record.evidence_refs.every((ref) => memory.inspected_refs.includes(ref)));
  return ready ? guidance.specification : guidance.investigation;
}
