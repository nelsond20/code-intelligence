import path from "node:path";
import type { Repository } from "../config/schema.js";
import { readTextSource, walkSourceFiles } from "../search/files.js";

export interface SymbolResult { repo: string; path: string; line: number; name: string; signature: string; backend: string; }

const DEFINITIONS = [
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)[^\n]*/g,
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:def\s+)?([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*(?::[^={]+)?[{:]/gm,
  /\b(?:func|struct|trait|fn)\s+([A-Za-z_$][\w$]*)[^\n]*/g,
];

export async function fallbackSymbolSearch(repositories: Repository[], requestedName: string, limit = 20): Promise<SymbolResult[]> {
  const target = requestedName.split(".").at(-1)!.toLowerCase();
  const results: SymbolResult[] = [];
  for (const repository of repositories) {
    for (const relative of await walkSourceFiles(repository.path)) {
      const source = await readTextSource(path.join(repository.path, relative));
      if (!source) continue;
      for (const regex of DEFINITIONS) {
        regex.lastIndex = 0;
        for (const match of source.matchAll(regex)) {
          const name = match[1];
          if (!name || (!name.toLowerCase().includes(target) && !target.includes(name.toLowerCase()))) continue;
          results.push({ repo: repository.id, path: relative, line: source.slice(0, match.index).split(/\r?\n/).length,
            name, signature: match[0].trim().slice(0, 500), backend: "local-fallback" });
          if (results.length >= limit) return results;
        }
      }
    }
  }
  return results.sort((a, b) => Number(b.name.toLowerCase() === target) - Number(a.name.toLowerCase() === target));
}
