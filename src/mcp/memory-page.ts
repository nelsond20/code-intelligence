import crypto from "node:crypto";
import type { TaskState, StructuredSpec } from "../task-state/schemas.js";

export interface MemoryPageRequest {
  section?: "records" | "requirements" | "summary" | "metadata" | "item";
  offset?: number;
  state_token?: string;
  item_id?: string;
}

const RESPONSE_BUDGET = 18_000;
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

/** Pages only large memory.current responses. The token binds pages to one persisted state. */
export function pageMemoryCurrent<T extends { memory: Omit<TaskState, "id"> & { spec?: StructuredSpec }; active_plan: unknown }>(
  response: T, request: MemoryPageRequest, internalBinding = "",
): unknown {
  const { memory } = response;
  const token = crypto.createHash("sha256").update(internalBinding).update("\0").update(JSON.stringify(response)).digest("hex");
  if (request.section) {
    if (request.state_token !== token) throw new Error("MEMORY_PAGE_STALE: Current memory changed; restart memory.current pagination");
    const offset = request.offset || 0;
    if (request.section === "item") {
      const record = memory.records.find((item) => item.id === request.item_id);
      const requirement = memory.spec?.requirements.find((item) => item.id === request.item_id);
      const item = record || requirement;
      if (!item) throw new Error("Unknown paginated item ID");
      const serialized = JSON.stringify(item);
      const text = serialized.slice(offset, offset + 8_000);
      return { section: "item", item_id: request.item_id, offset, text, total: serialized.length,
        next_offset: offset + text.length < serialized.length ? offset + text.length : null, state_token: token };
    }
    if (request.section === "summary") {
      const summary = memory.spec?.summary || "";
      const text = summary.slice(offset, offset + 8_000);
      return { section: "summary", offset, text, total: summary.length,
        next_offset: offset + text.length < summary.length ? offset + text.length : null, state_token: token };
    }
    if (request.section === "metadata") {
      const metadata = { ...memory, records: [], ...(memory.spec ? { spec: { ...memory.spec, requirements: [] } } : {}) };
      const serialized = JSON.stringify(metadata); const text = serialized.slice(offset, offset + 8_000);
      return { section: "metadata", offset, text, total: serialized.length,
        next_offset: offset + text.length < serialized.length ? offset + text.length : null, state_token: token };
    }
    const source = request.section === "records" ? memory.records : memory.spec?.requirements || [];
    const items: unknown[] = []; let position = offset;
    while (position < source.length && items.length < 25) {
      const item = source[position]!;
      if (bytes(item) > 12_000) {
        items.push({ id: item.id, oversized: true, next_action: `Retrieve with memory.current section=item item_id=${item.id}` });
        position++; continue;
      }
      const candidate = { section: request.section, items: [...items, item], offset, total: source.length,
        next_offset: position + 1, state_token: token };
      if (items.length && bytes(candidate) > RESPONSE_BUDGET) break;
      items.push(item); position++;
    }
    return { section: request.section, items, offset, total: source.length,
      next_offset: position < source.length ? position : null, state_token: token };
  }
  if (bytes(response) <= RESPONSE_BUDGET) return response;
  const spec = memory.spec;
  const summary = spec?.summary || "";
  let compact = { ...response, memory: { ...memory, records: [],
    record_ids: memory.records.map((item) => item.id),
    ...(spec ? { spec: { ...spec, summary: summary.slice(0, 1_000), requirements: [],
      requirement_ids: spec.requirements.map((item) => item.id) } } : {}) },
    continuation: { state_token: token, sections: {
      records: memory.records.length, requirements: spec?.requirements.length || 0,
      ...(summary.length > 1_000 ? { summary: summary.length } : {}),
    }, next_action: "Call memory.current with section, offset=0, and state_token; follow next_offset until null" } };
  if (bytes(compact) > RESPONSE_BUDGET) {
    const plan = response.active_plan as { status?: string; active?: boolean; guard_status?: string; stale?: boolean; revision?: number;
      step?: { id?: string; kind?: string; title?: string; covers?: string[] } };
    compact = { ...compact, active_plan: { status: plan.status, active: plan.active, guard_status: plan.guard_status,
      stale: plan.stale, revision: plan.revision, step: plan.step && { id: plan.step.id, kind: plan.step.kind,
        title: plan.step.title, covers: plan.step.covers }, next_action: "Call plan.current for the complete current step" } } as typeof compact;
  }
  if (bytes(compact) > RESPONSE_BUDGET) {
    compact = { ...compact, memory: { title: memory.title, status: memory.status, phase: memory.phase,
      objective: memory.objective.slice(0, 1_000), records: [], record_ids: memory.records.map((item) => item.id),
      ...(spec ? { spec: { revision: spec.revision, summary: summary.slice(0, 1_000), requirements: [],
        requirement_ids: spec.requirements.map((item) => item.id) } } : {}) },
      continuation: { ...compact.continuation, sections: { ...compact.continuation.sections,
        metadata: bytes({ ...memory, records: [], ...(spec ? { spec: { ...spec, requirements: [] } } : {}) }) } } } as typeof compact;
  }
  if (bytes(compact) > RESPONSE_BUDGET) throw new Error("MEMORY_PAGE_TOO_LARGE: Current plan or metadata exceeds the response budget");
  return compact;
}
