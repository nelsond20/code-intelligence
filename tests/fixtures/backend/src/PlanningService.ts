export class PlanningService {
  calculateDuration(startMs: number, endMs: number): number {
    return Math.round((endMs - startMs) / 60_000);
  }
}
