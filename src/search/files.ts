import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isGloballyIgnored } from "../privacy/ignores.js";

function globRegex(pattern: string): RegExp {
  let source = pattern.trim().replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  source = source.replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
  return new RegExp(pattern.includes("/") ? `^${source}(?:/.*)?$` : `(?:^|/)${source}(?:/.*)?$`);
}

async function repositoryIgnores(root: string): Promise<RegExp[]> {
  const patterns: string[] = [];
  for (const name of [".gitignore", ".codeintelligenceignore"]) {
    try {
      const text = await readFile(path.join(root, name), "utf8");
      patterns.push(...text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return patterns.map(globRegex);
}

export async function walkSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const ignores = await repositoryIgnores(root);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = next.replaceAll(path.sep, "/");
      if (isGloballyIgnored(normalized) || ignores.some((pattern) => pattern.test(normalized))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) output.push(normalized);
    }
  }
  await visit("");
  return output.sort();
}

export async function readTextSource(file: string, maxBytes = 2_000_000): Promise<string | undefined> {
  const value = await readFile(file);
  if (value.length > maxBytes || value.includes(0)) return undefined;
  return value.toString("utf8");
}

export function sourceHash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
