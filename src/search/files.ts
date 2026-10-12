import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";

export async function walkSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const policy = await RepositoryAccessPolicy.create(root);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = next.replaceAll(path.sep, "/");
      if (!policy.canIndex(normalized)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) output.push(normalized);
    }
  }
  await visit("");
  return output.sort();
}

export async function walkReadableFiles(root: string): Promise<string[]> {
  const output: string[] = []; const policy = await RepositoryAccessPolicy.create(root);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name; const normalized = next.replaceAll(path.sep, "/");
      if (!policy.canRead(normalized) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(next); else if (entry.isFile()) output.push(normalized);
    }
  }
  await visit(""); return output.sort();
}

export async function readTextSource(file: string, maxBytes = 2_000_000): Promise<string | undefined> {
  const value = await readFile(file);
  if (value.length > maxBytes || value.includes(0)) return undefined;
  return value.toString("utf8");
}

export function sourceHash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
