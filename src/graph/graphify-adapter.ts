import type { Repository } from "../config/schema.js";
import { sanitizedChildEnv } from "../privacy/child-env.js";
import { runProcess } from "../shared/process.js";

export class GraphifyAdapter {
  constructor(private readonly command = "graphify", private readonly timeoutMs = 10_000) {}
  async available(): Promise<boolean> {
    try { return (await runProcess(this.command, ["--version"], { env: sanitizedChildEnv("graphify"), timeoutMs: Math.min(this.timeoutMs, 3_000) })).code === 0; } catch { return false; }
  }
  async index(repository: Repository): Promise<void> {
    const result = await runProcess(this.command, ["index", "--code-only", "--path", repository.path], { env: sanitizedChildEnv("graphify"), timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(`Graphify indexing failed: ${result.stderr || `exit ${result.code}`}`);
  }
  async relations(repository: Repository, symbol: string, direction: string, depth: number): Promise<unknown[]> {
    const result = await runProcess(this.command, ["query", "--code-only", "--project", repository.path, "--symbol", symbol,
      "--direction", direction, "--depth", String(depth), "--json"], { env: sanitizedChildEnv("graphify"), maxBytes: 24_000, timeoutMs: this.timeoutMs });
    if (result.code !== 0) throw new Error(`Graphify query failed: ${result.stderr || `exit ${result.code}`}`);
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value)) throw new Error("Unexpected Graphify response");
    return value.slice(0, 50);
  }
}
