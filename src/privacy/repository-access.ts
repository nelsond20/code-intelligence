import path from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isGloballyIgnored } from "./ignores.js";

interface IgnoreRule {
  base: string;
  negate: boolean;
  directoryOnly: boolean;
  matcher: RegExp;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(raw: string): { negate: boolean; directoryOnly: boolean; matcher: RegExp } | undefined {
  let value = raw.trim();
  if (!value || value.startsWith("#")) return undefined;
  const negate = value.startsWith("!");
  if (negate) value = value.slice(1);
  if (!value) return undefined;
  const directoryOnly = value.endsWith("/");
  if (directoryOnly) value = value.slice(0, -1);
  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  let source = escapeRegex(value);
  source = source.replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
  const prefix = anchored || value.includes("/") ? "^" : "(?:^|/)";
  const suffix = directoryOnly ? "(?:/.*)?$" : "(?:$|/.*$)";
  return { negate, directoryOnly, matcher: new RegExp(`${prefix}${source}${suffix}`) };
}

async function loadIgnoreFile(root: string, directory: string, name: string): Promise<IgnoreRule[]> {
  try {
    const text = await readFile(path.join(root, directory, name), "utf8");
    return text.split(/\r?\n/).flatMap((line) => {
      const compiled = compilePattern(line);
      return compiled ? [{ base: normalize(directory), ...compiled }] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function discoverRules(root: string): Promise<{ security: IgnoreRule[]; index: IgnoreRule[] }> {
  const security: IgnoreRule[] = [];
  const index: IgnoreRule[] = [];
  async function visit(directory: string): Promise<void> {
    security.push(...await loadIgnoreFile(root, directory, ".codeintelligenceignore"));
    index.push(...await loadIgnoreFile(root, directory, ".gitignore"));
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relative = normalize(path.posix.join(directory, entry.name));
      if (isGloballyIgnored(relative)) continue;
      await visit(relative);
    }
  }
  await visit("");
  return { security, index };
}

function evaluate(rules: IgnoreRule[], relative: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    const candidate = rule.base && relative.startsWith(`${rule.base}/`) ? relative.slice(rule.base.length + 1)
      : rule.base === relative ? "" : rule.base ? undefined : relative;
    if (candidate !== undefined && rule.matcher.test(candidate)) ignored = !rule.negate;
  }
  return ignored;
}

/** Central, live repository policy. Persisted paths and opaque refs are always revalidated here. */
export class RepositoryAccessPolicy {
  private constructor(readonly root: string, private readonly securityRules: IgnoreRule[], private readonly indexRules: IgnoreRule[]) {}

  static async create(root: string): Promise<RepositoryAccessPolicy> {
    const canonical = await realpath(root);
    const rules = await discoverRules(canonical);
    return new RepositoryAccessPolicy(canonical, rules.security, rules.index);
  }

  canRead(relativePath: string): boolean {
    const relative = normalize(relativePath);
    return Boolean(relative) && !path.posix.isAbsolute(relative) && !relative.split("/").includes("..")
      && !isGloballyIgnored(relative) && !evaluate(this.securityRules, relative);
  }

  canIndex(relativePath: string): boolean {
    const relative = normalize(relativePath);
    return this.canRead(relative) && ![".gitignore", ".codeintelligenceignore"].includes(path.posix.basename(relative)) && !evaluate(this.indexRules, relative);
  }

  assertReadable(relativePath: string): string {
    const relative = normalize(relativePath);
    if (!this.canRead(relative)) throw new Error(`Path is excluded by repository access policy: ${relativePath}`);
    return relative;
  }

  async resolveFile(relativePath: string): Promise<{ absolute: string; relative: string }> {
    const relative = this.assertReadable(relativePath);
    const candidate = path.resolve(this.root, relative);
    const lexical = path.relative(this.root, candidate);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) throw new Error("Path escapes the repository");
    const canonical = await realpath(candidate);
    const canonicalRelative = normalize(path.relative(this.root, canonical));
    if (canonicalRelative.startsWith("../") || path.isAbsolute(canonicalRelative)) throw new Error("Symlink escapes the repository");
    this.assertReadable(canonicalRelative);
    if (!(await stat(canonical)).isFile()) throw new Error("Path is not a regular file");
    return { absolute: canonical, relative: canonicalRelative };
  }
}
