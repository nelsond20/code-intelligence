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
  const root = await realpath(rootPath);
  const raw = requested.replaceAll("\\", "/");
  // Absolute model paths are rooted at this repository, never its workspace parent.
  const relativeInput = path.isAbsolute(raw) ? contained(root, raw) : raw;
  if (!relativeInput || relativeInput === ".") throw new Error("Path escapes the repository");
  const policy = await RepositoryAccessPolicy.create(root);
  let canonical = root;
  for (const segment of relativeInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      canonical = path.dirname(canonical);
      if (canonical === root || canonical.startsWith(`${root}${path.sep}`)) continue;
      throw new Error("Path escapes the repository");
    }
    const next = path.join(canonical, segment);
    let resolved = false;
    try { canonical = await realpath(next); resolved = true; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      if (!allowMissing) throw new Error(`Context file does not exist: ${relativeInput}`);
      canonical = next;
    }
    if (canonical !== root) {
      try { contained(root, canonical); }
      catch { throw new Error(resolved ? "Symlink escapes the repository" : "Path escapes the repository"); }
    }
  }
  let ancestor = canonical;
  while (true) {
    try { const info = await stat(ancestor);
      if (ancestor === canonical && !info.isFile()) throw new Error(`Writable path is not a regular file: ${relativeInput}`);
      if (ancestor !== canonical && !info.isDirectory()) throw new Error(`Writable path has a non-directory ancestor: ${relativeInput}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      if (!allowMissing) throw new Error(`Context file does not exist: ${relativeInput}`);
      ancestor = path.dirname(ancestor);
    }
  }
  let canonicalRelative: string;
  try { canonicalRelative = contained(root, canonical); }
  catch { throw new Error("Symlink escapes the repository"); }
  policy.assertReadable(canonicalRelative);
  return canonicalRelative;
}
