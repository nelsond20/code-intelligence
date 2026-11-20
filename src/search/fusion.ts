import type { SearchResult } from "./types.js";

export function fuseResults(lexical: SearchResult[], semantic: SearchResult[], limit: number): SearchResult[] {
  const fused = new Map<string, SearchResult>();
  const add = (result: SearchResult, rank: number, kind: "lexical" | "semantic") => {
    const overlap = [...fused.entries()].find(([, item]) => item.repo === result.repo && item.path === result.path
      && (item.symbol && result.symbol ? item.symbol === result.symbol : Math.max(item.start_line, result.start_line) <= Math.min(item.end_line, result.end_line)));
    const key = overlap?.[0] || `${result.repo}:${result.path}:${result.symbol || `${result.start_line}:${result.end_line}`}`;
    const contribution = 1 / (60 + rank);
    const existing = fused.get(key);
    if (existing) {
      existing.score += contribution;
      existing.reason = "fused lexical + semantic";
      if (kind === "semantic") existing.semantic_score = result.semantic_score;
      else existing.lexical_score = result.lexical_score;
    } else fused.set(key, { ...result, score: contribution });
  };
  lexical.forEach((result, index) => add(result, index + 1, "lexical"));
  semantic.forEach((result, index) => add(result, index + 1, "semantic"));
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const diverse: SearchResult[] = []; const used = new Set<string>();
  for (const item of ranked) { const key = `${item.repo}:${item.path}`; if (!used.has(key)) { diverse.push(item); used.add(key); } if (diverse.length >= limit) return diverse; }
  for (const item of ranked) if (!diverse.includes(item)) { diverse.push(item); if (diverse.length >= limit) break; }
  return diverse;
}
