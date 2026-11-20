import path from "node:path";
import type { Repository } from "../config/schema.js";
import { walkSourceFiles, readTextSource } from "./files.js";
import type { SearchResult } from "./types.js";
import { containingSymbol, parseSymbols } from "../symbols/parser.js";
import { runProcess } from "../shared/process.js";

function terms(query: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "what", "where", "when", "be", "is", "to", "of",
    "como", "para", "con", "desde", "este", "esta", "donde", "cuando", "que", "ser", "es", "de"]);
  const variants = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s._$-]+/).map((value) => value.toLowerCase());
  const phrase = query.trim().toLowerCase();
  return [...new Set([phrase, ...variants].filter((value) => value.length >= 2 && !stop.has(value)))].slice(0, 24);
}

async function rgCandidates(repository: Repository, files: string[], needles: string[]): Promise<Map<string, Set<number>> | undefined> {
  const output = new Map<string, Set<number>>();
  try {
    for (let offset = 0; offset < files.length; offset += 200) {
      const args = ["--json", "--line-number", "--ignore-case", "--fixed-strings", "--color", "never",
        ...needles.flatMap((needle) => ["-e", needle]), "--", ...files.slice(offset, offset + 200)];
      const result = await runProcess("rg", args, { cwd: repository.path, timeoutMs: 5_000, maxBytes: 4_000_000 });
      if (result.code > 1) return undefined;
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number } };
        const relative = event.data?.path?.text?.replaceAll("\\", "/"); const lineNumber = event.data?.line_number;
        if (event.type === "match" && relative && Number.isInteger(lineNumber)) {
          if (!output.has(relative)) output.set(relative, new Set()); output.get(relative)!.add(lineNumber!);
        }
      }
    }
    return output;
  } catch { return undefined; }
}

export async function lexicalSearch(repositories: Repository[], query: string, limit = 8): Promise<SearchResult[]> {
  const needles = terms(query);
  if (!needles.length) throw new Error("Search query must contain searchable text");
  const results: SearchResult[] = [];
  for (const repository of repositories) {
    const files = await walkSourceFiles(repository.path); const candidates = await rgCandidates(repository, files, needles);
    for (const relative of files) {
      if (candidates && !candidates.has(relative)) continue;
      const source = await readTextSource(path.join(repository.path, relative));
      if (source === undefined) continue;
      const lines = source.split(/\r?\n/);
      const symbols = parseSymbols(source, relative);
      let lastResult: SearchResult | undefined;
      for (let index = 0; index < lines.length; index++) {
        if (candidates && !candidates.get(relative)?.has(index + 1)) continue;
        const line = lines[index]!;
        const lower = line.toLowerCase();
        const matches = needles.filter((term) => lower.includes(term));
        if (!matches.length) continue;
        const exact = lower.includes(query.toLowerCase()) ? 5 : 0;
        const filename = needles.some((term) => relative.toLowerCase().includes(term)) ? 2 : 0;
        const score = exact + filename + matches.length + Math.min(2, matches.reduce((n, term) => n + lower.split(term).length - 1, 0) / 4);
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        if (lastResult && lastResult.path === relative && from + 1 <= lastResult.end_line + 2) {
          lastResult.end_line = Math.max(lastResult.end_line, to);
          lastResult.snippet = lines.slice(lastResult.start_line - 1, lastResult.end_line).join("\n").slice(0, 1200);
          lastResult.score = Math.max(lastResult.score, score) + 0.25;
          continue;
        }
        const symbol = containingSymbol(symbols, index + 1);
        lastResult = {
          repo: repository.id, path: relative, start_line: from + 1, end_line: to,
          snippet: lines.slice(from, to).join("\n").slice(0, 1200), reason: `lexical: ${matches.join(", ")}`,
          lexical_score: score, score, symbol: symbol?.qualified_name,
        };
        results.push(lastResult);
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.start_line - b.start_line).slice(0, limit);
}
