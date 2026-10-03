import type { SearchResult } from "./types.js";

export function fuseResults(lexical: SearchResult[], semantic: SearchResult[], limit: number): SearchResult[] {
  const fused = new Map<string, SearchResult>();
  const add = (result: SearchResult, rank: number, kind: "lexical" | "semantic") => {
    const key = `${result.repo}:${result.path}:${result.start_line}:${result.end_line}`;
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
  return [...fused.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
