import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";

function contained(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes the repository");
  return relative.replaceAll(path.sep, "/");
}

/** Canonicalize a repository file target, including descendants of future directories. */
export async function canonicalTarget(rootPath: string, requested: string, allowMissing: boolean): Promise<string> {
  if (path.isAbsolute(requested)) throw new Error("Absolute writable paths are not allowed");
  const normalized = path.posix.normalize(requested.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error("Path escapes the repository");
  const root = await realpath(rootPath);
  const policy = await RepositoryAccessPolicy.create(root);
  policy.assertReadable(normalized);
  const candidate = path.resolve(root, normalized);
  contained(root, candidate);
  let ancestor = candidate;
  const missing: string[] = [];
  let canonical: string;
  while (true) {
    try { canonical = await realpath(ancestor); break; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      if (!allowMissing) throw new Error(`Context file does not exist: ${normalized}`);
      if (ancestor === root) throw new Error("Path escapes the repository");
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  if (missing.length) {
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Writable path has a non-directory ancestor: ${normalized}`);
    canonical = path.join(canonical, ...missing);
  } else if (!(await stat(canonical)).isFile()) throw new Error(`Writable path is not a regular file: ${normalized}`);
  let canonicalRelative: string;
  try { canonicalRelative = contained(root, canonical); }
  catch { throw new Error("Symlink escapes the repository"); }
  policy.assertReadable(canonicalRelative);
  return canonicalRelative;
}
