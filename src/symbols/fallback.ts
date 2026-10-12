import path from "node:path";
import type { Repository } from "../config/schema.js";
import { readTextSource, walkSourceFiles } from "../search/files.js";
import { parseSymbols, structuralParserForPath } from "./parser.js";

export interface SymbolResult { repo: string; path: string; line: number; name: string; signature: string; backend: string; }

export async function fallbackSymbolSearch(repositories: Repository[], requestedName: string, limit = 20): Promise<SymbolResult[]> {
  const target = requestedName.split(".").at(-1)!.toLowerCase();
  const results: SymbolResult[] = [];
  for (const repository of repositories) {
    for (const relative of await walkSourceFiles(repository.path)) {
      const source = await readTextSource(path.join(repository.path, relative));
      if (!source) continue;
      for (const symbol of parseSymbols(source, relative)) {
        const candidate = symbol.qualified_name.toLowerCase();
        if (!symbol.name.toLowerCase().includes(target) && !candidate.includes(target) && !target.includes(symbol.name.toLowerCase())) continue;
        results.push({ repo: repository.id, path: relative, line: symbol.start_line,
          name: symbol.qualified_name, signature: symbol.signature, backend: structuralParserForPath(relative) });
        if (results.length >= limit) return results;
      }
    }
  }
  return results.sort((a, b) => Number(b.name.toLowerCase() === target) - Number(a.name.toLowerCase() === target)
    || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.line - b.line);
}
