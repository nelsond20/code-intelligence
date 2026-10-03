import { durationMinutes } from "shared-duration";

export function renderPlanning(start: Date, end: Date): string {
  return `${durationMinutes(start, end)} minutes`;
}
