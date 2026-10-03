import { constants } from "node:fs";
import { access, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function withFileLock<T>(target: string, action: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const lock = `${target}.lock`;
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try { return await action(); } finally { await handle.close(); await rm(lock, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${path.basename(target)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function resolveInside(root: string, requested: string): Promise<{ absolute: string; relative: string }> {
  if (path.isAbsolute(requested)) throw new Error("Absolute paths are not allowed");
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, requested);
  const lexicalRelative = path.relative(canonicalRoot, candidate);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) throw new Error("Path escapes the repository");
  const canonical = await realpath(candidate);
  const relative = path.relative(canonicalRoot, canonical);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Symlink escapes the repository");
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("Path is not a regular file");
  return { absolute: canonical, relative: relative.replaceAll(path.sep, "/") };
}

export async function assertReadableDirectory(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${directory}`);
  await access(canonical, constants.R_OK);
  return canonical;
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
  let end = Math.min(value.length, maxBytes);
  while (Buffer.byteLength(value.slice(0, end)) > maxBytes - 32) end -= 1;
  return { text: `${value.slice(0, end)}\n… [truncated]`, truncated: true };
}
