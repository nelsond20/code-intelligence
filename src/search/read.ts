import { readFile } from "node:fs/promises";
import type { Repository } from "../config/schema.js";
import { isGloballyIgnored } from "../privacy/ignores.js";
import { resolveInside, truncateUtf8 } from "../shared/fs.js";

export async function readCode(repository: Repository, requestedPath: string, startLine = 1, endLine?: number, maxLines = 400, maxBytes = 16_000) {
  if (isGloballyIgnored(requestedPath)) throw new Error("Path is excluded by the security ignore policy");
  const resolved = await resolveInside(repository.path, requestedPath);
  if (isGloballyIgnored(resolved.relative)) throw new Error("Path is excluded by the security ignore policy");
  const lines = (await readFile(resolved.absolute, "utf8")).split(/\r?\n/);
  const start = Math.max(1, Math.trunc(startLine));
  const requestedEnd = endLine === undefined ? start + Math.min(200, maxLines) - 1 : Math.trunc(endLine);
  const end = Math.min(lines.length, requestedEnd, start + maxLines - 1);
  if (end < start) throw new Error("end_line must be greater than or equal to start_line");
  const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
  const bounded = truncateUtf8(numbered, maxBytes);
  return { repo: repository.id, path: resolved.relative, start_line: start, end_line: end, content: bounded.text,
    truncated: bounded.truncated || end < requestedEnd || end < lines.length && endLine === undefined, total_lines: lines.length };
}
