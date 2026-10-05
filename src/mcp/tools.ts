import { contextFindInput, contextInspectInput, memoryInput, planInput } from "./schemas.js";
import type { ToolRuntime } from "./runtime.js";

export const PUBLIC_TOOL_NAMES = ["context.find", "context.inspect", "memory", "plan"] as const;
type Register = (name: string, description: string, schema: any, handler: (input: any) => Promise<unknown>) => void;

export function registerPublicTools(register: Register, runtime: ToolRuntime): void {
  register("context.find", "Find a small ranked set of local refs. Use this before inspect; results declare the views each ref supports and retrieval diagnostics.", contextFindInput, (value) => runtime.contextFind(value));
  register("context.inspect", "Inspect one ref returned by context.find. Reuse the ref exactly and select only one of its available_views.", contextInspectInput, (value) => runtime.contextInspect(value));
  register("memory", `Create a memory: {"action":"new","title":"Investigate bug"}. To create one constraint MUST spec requirement, call action spec_replace: {"action":"spec_replace","summary":"Goal","requirements":[{"statement":"Observable condition","kind":"constraint","priority":"must"}]}. "must" is a requirement priority, not an action; spec_must is invalid. Do not invent IDs or add state/context to new.
Persistent work memory also supports current, read, note, and resolve. note: {"action":"note","type":"evidence","text":"Observed behavior","evidence_refs":["<inspected ref>"]}; resolve: {"action":"resolve","record_id":"M1","status":"confirmed","reason":"Inspected source"}. spec_replace takes summary and requirements at the top level. Refs must first be inspected in this memory.`, memoryInput, (value) => runtime.memory(value));
  register("plan", `Create an investigation step: {"action":"create","steps":[{"kind":"investigation","title":"Inspect","objective":"Find evidence","covers":["R1"],"acceptance":[{"statement":"Evidence found","covers":["R1"]}],"verification":[{"kind":"custom","program":"node","args":["--version"]}]}]}. No top-level title or step ID. The server assigns S*, A*, V* IDs.
Guarded plan actions include create, current, complete, revise, suspend, reactivate, and abandon. Use current before mutation. Implementation steps require writes; investigation/verification steps forbid writes. With a structured spec, cover R* IDs on each step, write, and acceptance object; each behavior/must requirement needs test verification. Use {"action":"abandon","reason":"..."} to abandon.`, planInput, (value) => runtime.plan(value));
}
