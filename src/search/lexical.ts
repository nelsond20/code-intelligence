import path from "node:path";
import type { Repository } from "../config/schema.js";
import { walkSourceFiles, readTextSource } from "./files.js";
import type { SearchResult } from "./types.js";

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.$-]{2,}/gu) || [])].slice(0, 20);
}

export async function lexicalSearch(repositories: Repository[], query: string, limit = 8): Promise<SearchResult[]> {
  const needles = terms(query);
  if (!needles.length) throw new Error("Search query must contain searchable text");
  const results: SearchResult[] = [];
  for (const repository of repositories) {
    for (const relative of await walkSourceFiles(repository.path)) {
      const source = await readTextSource(path.join(repository.path, relative));
      if (source === undefined) continue;
      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const lower = line.toLowerCase();
        const matches = needles.filter((term) => lower.includes(term));
        if (!matches.length) continue;
        const exact = lower.includes(query.toLowerCase()) ? 5 : 0;
        const filename = needles.some((term) => relative.toLowerCase().includes(term)) ? 2 : 0;
        const score = exact + filename + matches.length + Math.min(2, matches.reduce((n, term) => n + lower.split(term).length - 1, 0) / 4);
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        results.push({
          repo: repository.id, path: relative, start_line: from + 1, end_line: to,
          snippet: lines.slice(from, to).join("\n").slice(0, 1200), reason: `lexical: ${matches.join(", ")}`,
          lexical_score: score, score,
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.start_line - b.start_line).slice(0, limit);
}
