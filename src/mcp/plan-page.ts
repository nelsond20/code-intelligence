import crypto from "node:crypto";

export interface PlanPageRequest {
  section?: "writes" | "context" | "acceptance" | "verification" | "item";
  offset?: number;
  state_token?: string;
  item_id?: string;
}

type Step = { id: string; writes: unknown[]; required_checks?: Array<{ id?: string }> };
type Current = { step?: Step };
const BUDGET = 18_000;
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

export function pagePlanCurrent<T extends Current>(response: T, request: PlanPageRequest): unknown {
  if (!response.step) return response;
  const token = crypto.createHash("sha256").update(JSON.stringify(response)).digest("hex");
  if (request.section) {
    if (request.state_token !== token) throw new Error("PLAN_PAGE_STALE: Current plan changed; restart plan.current pagination");
    const offset = request.offset || 0;
    if (request.section === "item") {
      const match = /^(writes|context|acceptance|verification):([0-9]+)$/.exec(request.item_id || "");
      if (!match) throw new Error("Unknown paginated plan item ID");
      const list = (response.step as unknown as Record<string, unknown[]>)[match[1]!] || [];
      const item = list[Number(match[2])];
      if (!item) throw new Error("Unknown paginated plan item ID");
      const serialized = JSON.stringify(item); const text = serialized.slice(offset, offset + 8_000);
      return { section: "item", item_id: request.item_id, offset, text, total: serialized.length,
        next_offset: offset + text.length < serialized.length ? offset + text.length : null, state_token: token };
    }
    const source = (response.step as unknown as Record<string, unknown[]>)[request.section] || []; const items: unknown[] = []; let position = offset;
    while (position < source.length && items.length < 20) {
      const item = source[position]!;
      if (bytes(item) > 12_000) { items.push({ item_id: `${request.section}:${position}`, oversized: true }); position++; continue; }
      if (items.length && bytes({ section: request.section, items: [...items, item], state_token: token }) > BUDGET) break;
      items.push(item); position++;
    }
    return { section: request.section, items, offset, total: source.length,
      next_offset: position < source.length ? position : null, state_token: token };
  }
  if (bytes(response) <= BUDGET) return response;
  const step = response.step;
  const legacy = step as Step & { context?: unknown[]; acceptance?: Array<{ id?: string }>; verification?: Array<{ id?: string }> };
  let summary = { ...response, step: { ...step, writes: [], context: [], acceptance: [], verification: [], write_paths: step.writes.map((item) =>
    typeof item === "string" ? item : `${(item as { repo?: string }).repo}:${(item as { path?: string }).path}`),
    acceptance_ids: (legacy.acceptance || []).map((item) => item.id), verification_ids: (legacy.verification || []).map((item) => item.id) },
    continuation: { state_token: token, sections: { writes: step.writes.length, context: legacy.context?.length || 0,
      acceptance: legacy.acceptance?.length || 0, verification: legacy.verification?.length || 0 },
      next_action: "Call plan.current with section, offset=0, and state_token; follow next_offset until null" } };
  if (bytes(summary) > BUDGET) summary = { ...summary, step: { ...summary.step, write_paths: [] } };
  if (bytes(summary) > BUDGET) throw new Error("PLAN_PAGE_TOO_LARGE: Current plan metadata exceeds the response budget");
  return summary;
}
