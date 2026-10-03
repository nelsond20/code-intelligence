import path from "node:path";
import type { Repository } from "../config/schema.js";
import { readTextSource, walkSourceFiles } from "../search/files.js";

export interface Relation { repo: string; path: string; line: number; relation: string; excerpt: string; }

export async function fallbackRelations(repository: Repository, symbol: string, direction: string, depth = 1): Promise<Relation[]> {
  const short = symbol.split(".").at(-1)!;
  const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`\\b${escaped}\\b`);
  const importPattern = /\b(?:import|require|from|use)\b/;
  const results: Relation[] = [];
  for (const relative of await walkSourceFiles(repository.path)) {
    const source = await readTextSource(path.join(repository.path, relative));
    if (!source) continue;
    source.split(/\r?\n/).forEach((line, index) => {
      const relationshipMatches = direction === "dependencies" || direction === "dependents" ? importPattern.test(line) && reference.test(line) : reference.test(line);
      if (relationshipMatches && results.length < Math.min(50, depth * 20)) {
        results.push({ repo: repository.id, path: relative, line: index + 1, relation: direction, excerpt: line.trim().slice(0, 500) });
      }
    });
  }
  return results;
}
