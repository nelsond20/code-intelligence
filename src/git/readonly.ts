import type { Repository } from "../config/schema.js";
import { isGloballyIgnored } from "../privacy/ignores.js";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";
import { truncateUtf8 } from "../shared/fs.js";
import { runProcess } from "../shared/process.js";

const HASH = /^[0-9a-f]{7,64}$/i;
function commitHash(value: string): string { if (!HASH.test(value)) throw new Error("Invalid commit hash"); return value; }
function repositoryPath(value: string): string {
  if (!value || value.startsWith("-") || value.startsWith("/") || value.split(/[\\/]/).includes("..") || isGloballyIgnored(value)) throw new Error("Invalid or excluded repository path");
  return value;
}

export interface GitCommitMatch { commit: string; date: string; subject: string; files: string[]; reason: string; }

export class ReadonlyGit {
  constructor(private readonly maxBytes = 16_000) {}
  private async execute(repository: Repository, args: string[], maxBytes = this.maxBytes) {
    const common = ["-c", "core.pager=cat", "-c", "pager.show=false", "-c", "diff.external=", "-c", "diff.trustExitCode=false",
      "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never"];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("SSH_")));
    Object.assign(env, { GIT_PAGER: "cat", PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
    const result = await runProcess("git", [...common, ...args], {
      cwd: repository.path, env,
      maxBytes: maxBytes * 2, timeoutMs: 15_000,
    });
    if (result.code !== 0) throw new Error(`Git read failed: ${result.stderr || `exit ${result.code}`}`);
    return result.stdout;
  }

  async status(repository: Repository) {
    const output = await this.execute(repository, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]);
    return { repo: repository.id, status: truncateUtf8(output, this.maxBytes).text };
  }

  async searchHistory(repository: Repository, query: string, limit = 8): Promise<GitCommitMatch[]> {
    const clean = query.trim().slice(0, 500); if (!clean) throw new Error("Git history query is empty");
    const count = Math.max(1, Math.min(20, limit));
    const format = "@@%H%x1f%ad%x1f%s";
    const searches: Array<{ args: string[]; reason: string }> = [
      { args: ["log", `--max-count=${count}`, "--date=iso-strict", `--format=${format}`, `--grep=${clean}`, "--regexp-ignore-case", "--name-only"], reason: "commit message" },
      { args: ["log", `--max-count=${count}`, "--date=iso-strict", `--format=${format}`, `-S${clean}`, "--name-only"], reason: "changed text" },
    ];
    const found = new Map<string, GitCommitMatch>();
    const policy = await RepositoryAccessPolicy.create(repository.path);
    for (const search of searches) {
      const output = await this.execute(repository, search.args, 40_000);
      for (const block of output.split(/^@@/m).filter(Boolean)) {
        const [header, ...fileLines] = block.trim().split(/\r?\n/); const [commit, date, subject] = (header || "").split("\x1f");
        if (!commit || !HASH.test(commit)) continue;
        const files = fileLines.map((line) => line.trim()).filter((line) => line && policy.canRead(line)).slice(0, 30);
        const previous = found.get(commit);
        found.set(commit, { commit, date: date || "", subject: subject || "", files: [...new Set([...(previous?.files || []), ...files])],
          reason: previous ? `${previous.reason} + ${search.reason}` : search.reason });
      }
    }
    return [...found.values()].slice(0, count);
  }

  async commitSummary(repository: Repository, commit: string) {
    const hash = commitHash(commit);
    const output = await this.execute(repository, ["show", "--no-ext-diff", "--no-textconv", "--format=%H%x1f%an%x1f%ad%x1f%s", "--date=iso-strict", "--numstat", "--no-renames", hash], 40_000);
    const [header, ...rows] = output.trim().split(/\r?\n/); const [full, author, date, subject] = (header || "").split("\x1f");
    const policy = await RepositoryAccessPolicy.create(repository.path);
    const files = rows.map((row) => {
      const [added, deleted, ...rest] = row.split("\t"); const file = rest.join("\t");
      return file && policy.canRead(file) ? { path: file, insertions: added === "-" ? undefined : Number(added), deletions: deleted === "-" ? undefined : Number(deleted) } : undefined;
    }).filter((item): item is NonNullable<typeof item> => item !== undefined).slice(0, 100);
    const totals = files.reduce((sum, file) => ({ insertions: sum.insertions + (file.insertions || 0), deletions: sum.deletions + (file.deletions || 0) }), { insertions: 0, deletions: 0 });
    const changedSymbols = await this.changedSymbols(repository, hash);
    return { repo: repository.id, commit: full || hash, subject: subject || "", author: author || "", date: date || "", files, ...totals, changed_symbols: changedSymbols, truncated: rows.length > 100 };
  }

  async commitDiff(repository: Repository, commit: string, file?: string) {
    const hash = commitHash(commit); const policy = await RepositoryAccessPolicy.create(repository.path);
    const files = file ? [policy.assertReadable(repositoryPath(file))] : (await this.commitSummary(repository, hash)).files.map((item) => item.path);
    const patches: string[] = [];
    for (const allowed of files) patches.push(await this.execute(repository,
      ["show", "--no-ext-diff", "--no-textconv", "--format=", "--patch", "--unified=20", hash, "--", allowed], this.maxBytes * 2));
    const raw = patches.join("\n"); const bounded = truncateUtf8(raw, this.maxBytes);
    return { repo: repository.id, commit, file, diff: bounded.text, truncated: bounded.truncated };
  }

  async blame(repository: Repository, file: string, commit: string, start = 1, end = 200) {
    const path = (await RepositoryAccessPolicy.create(repository.path)).assertReadable(repositoryPath(file)); const from = Math.max(1, start); const to = Math.min(Math.max(from, end), from + 399);
    const raw = await this.execute(repository, ["blame", "--porcelain", `-L${from},${to}`, commitHash(commit), "--", path]);
    const bounded = truncateUtf8(raw, this.maxBytes);
    return { repo: repository.id, commit, file: path, start_line: from, end_line: to, blame: bounded.text, truncated: bounded.truncated };
  }

  private async changedSymbols(repository: Repository, commit: string): Promise<string[]> {
    const diff = await this.execute(repository, ["show", "--no-ext-diff", "--no-textconv", "--format=", "--unified=0", commit], 20_000);
    const symbols = new Set<string>();
    for (const line of diff.split(/\r?\n/)) {
      if (!line.startsWith("@@")) continue;
      const context = line.replace(/^@@[^@]*@@\s*/, "");
      const match = context.match(/(?:function|class|def|func|fn)?\s*([A-Za-z_$][\w$]*)\s*(?:\(|\{|$)/);
      if (match?.[1] && !["if", "for", "while", "switch"].includes(match[1])) symbols.add(match[1]);
    }
    return [...symbols].slice(0, 30);
  }
}
