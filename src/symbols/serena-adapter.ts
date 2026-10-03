import type { Repository } from "../config/schema.js";
import { sanitizedChildEnv } from "../privacy/child-env.js";
import { runProcess } from "../shared/process.js";
import type { SymbolResult } from "./fallback.js";

export class SerenaAdapter {
  constructor(private readonly command = "serena", private readonly timeoutMs = 10_000) {}
  async available(): Promise<boolean> {
    try { return (await runProcess(this.command, ["--version"], { env: sanitizedChildEnv("serena"), timeoutMs: Math.min(this.timeoutMs, 3_000) })).code === 0; } catch { return false; }
  }
  async symbol(repository: Repository, name: string): Promise<SymbolResult[]> {
    const result = await runProcess(this.command, ["symbol", "--project", repository.path, "--name", name, "--json"],
      { env: sanitizedChildEnv("serena"), maxBytes: 20_000, timeoutMs: this.timeoutMs });
    if (result.code !== 0) throw new Error(`Serena symbol query failed: ${result.stderr || `exit ${result.code}`}`);
    const parsed = JSON.parse(result.stdout) as Array<{ path: string; line: number; name: string; signature?: string }>;
    return parsed.slice(0, 20).map((item) => ({ repo: repository.id, path: item.path, line: item.line, name: item.name,
      signature: item.signature || item.name, backend: "serena" }));
  }
  async references(repository: Repository, symbol: string): Promise<unknown[]> {
    const result = await runProcess(this.command, ["references", "--project", repository.path, "--symbol", symbol, "--json"],
      { env: sanitizedChildEnv("serena"), maxBytes: 24_000, timeoutMs: this.timeoutMs });
    if (result.code !== 0) throw new Error(`Serena references query failed: ${result.stderr || `exit ${result.code}`}`);
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value)) throw new Error("Unexpected Serena response");
    return value.slice(0, 50);
  }
}
