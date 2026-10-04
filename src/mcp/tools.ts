import { contextFindInput, contextInspectInput, memoryInput, planInput } from "./schemas.js";
import type { ToolRuntime } from "./runtime.js";

export const PUBLIC_TOOL_NAMES = ["context.find", "context.inspect", "memory", "plan"] as const;
type Register = (name: string, description: string, schema: any, handler: (input: any) => Promise<unknown>) => void;

export function registerPublicTools(register: Register, runtime: ToolRuntime): void {
  register("context.find", "Find a small ranked set of local refs. Use this before inspect; results declare the views each ref supports and retrieval diagnostics.", contextFindInput, (value) => runtime.contextFind(value));
  register("context.inspect", "Inspect one ref returned by context.find. Reuse the ref exactly and select only one of its available_views.", contextInspectInput, (value) => runtime.contextInspect(value));
  register("memory", "Create/resume work, maintain evidence-backed records and structured requirements, or read/search completed outcomes. Call current first when resuming.", memoryInput, (value) => runtime.memory(value));
  register("plan", "Create and follow the server-owned requirement coverage ledger. Call current before mutation and complete only after fresh verification.", planInput, (value) => runtime.plan(value));
}
