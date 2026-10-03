import { contextFindInput, contextInspectInput, memoryInput, planInput } from "./schemas.js";
import type { ToolRuntime } from "./runtime.js";

export const PUBLIC_TOOL_NAMES = ["context.find", "context.inspect", "memory", "plan"] as const;
type Register = (name: string, description: string, schema: any, handler: (input: any) => Promise<unknown>) => void;

export function registerPublicTools(register: Register, runtime: ToolRuntime): void {
  register("context.find", "Discover relevant local code, documentation, personal knowledge, and Git history through one broker.", contextFindInput, (value) => runtime.contextFind(value));
  register("context.inspect", "Inspect bounded content, surroundings, relations, references, or Git change details for a discovered ref.", contextInspectInput, (value) => runtime.contextInspect(value));
  register("memory", "Manage persistent semantic work memory: objectives, specification, findings, evidence, decisions, hypotheses, questions, blockers, and relevant context.", memoryInput, (value) => runtime.memory(value));
  register("plan", "Control an optional spec-bound ordered execution plan. The server owns the current step and advances only after mechanical completion gates pass.", planInput, (value) => runtime.plan(value));
}
