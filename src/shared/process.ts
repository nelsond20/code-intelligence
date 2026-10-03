import { spawn } from "node:child_process";
import { truncateUtf8 } from "./fs.js";

export async function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBytes?: number; timeoutMs?: number } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [], errors: Buffer[] = []; const limit = options.maxBytes || 32_000; let outputBytes = 0; let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs || 10_000);
    child.stdout.on("data", (chunk) => { const value = Buffer.from(chunk); const remaining = limit + 256 - outputBytes;
      if (remaining > 0) { chunks.push(value.subarray(0, remaining)); outputBytes += Math.min(value.length, remaining); } if (value.length > remaining) overflow = true; });
    child.stderr.on("data", (chunk) => { if (Buffer.concat(errors).length < 4_256) errors.push(Buffer.from(chunk).subarray(0, 4_256 - Buffer.concat(errors).length)); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = truncateUtf8(Buffer.concat(chunks).toString("utf8"), limit);
      const stderr = truncateUtf8(Buffer.concat(errors).toString("utf8"), 4_000).text;
      resolve({ code: code ?? -1, stdout: output.text, stderr, truncated: output.truncated || overflow });
    });
  });
}
