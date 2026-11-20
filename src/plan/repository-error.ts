export class PlanRepositoryError extends Error {
  constructor(
    readonly code: "PLAN_WRITE_REPOSITORY_REQUIRED" | "PLAN_WRITE_REPOSITORY_AMBIGUOUS" | "PLAN_REPOSITORY_RESOLUTION_FAILED" | "PLAN_BASELINE_FAILED",
    readonly operation: string,
    readonly repo?: string,
    readonly target?: string,
    cause?: unknown,
  ) {
    const subject = [repo && `repository ${repo}`, target && `path ${target}`].filter(Boolean).join(", ");
    super(`${operation} failed${subject ? ` for ${subject}` : ""}`, { cause });
    this.name = "PlanRepositoryError";
  }
}
