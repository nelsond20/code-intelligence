export const managedAgentsBlock = `<!-- CODE_INTELLIGENCE_BEGIN -->
## Local context broker, memory, and guarded plans

- **FIND:** Use \`context.find\` to discover relevant code, docs, or personal knowledge.
- **INSPECT:** Use \`context.inspect\` for exact content, surroundings, references, or relations from a discovered ref.
- Refs are opaque broker handles. Pass them exactly as returned by \`context.find\`; never decode, reconstruct, edit, or guess them. Ephemeral refs may require repeating \`context.find\` after restart or eviction.
- **MEMORY:** Use \`memory\` as persistent work memory. Call \`memory current\` when resuming substantial work. Record durable observations, evidence, hypotheses, decisions, questions, blockers, and relevant context early. The confirmed spec belongs to memory.
- **PLAN:** When an active plan exists, call \`plan current\` to learn the server-owned current step. Do not work ahead or modify paths outside that step. Request \`plan complete\` only after required verification. Use \`plan revise\` with a reason instead of silently deviating.
- The MCP workspace is configured by the host. Never pass or guess a workspace ID. Use \`scope\` only to restrict Code/Git discovery to a repository inside that workspace; Docs and Vault ignore it.
- For change review, use read-only Git or broker Git inspection to determine what changed, then \`context.find\`/\`context.inspect\` to determine impact. Prefer summary/file views over large diffs.
- Context inspection may record inspected refs, files, symbols, and commits mechanically. Use \`memory\` notes for semantic findings, hypotheses, decisions, and conclusions.
<!-- CODE_INTELLIGENCE_END -->`;

export const pluginSource = `// CODE_INTELLIGENCE_MANAGED_PLUGIN
import { spawn } from "node:child_process"

const MAX_CONTEXT_BYTES = 12000
const MAX_GUARD_BYTES = 16000
const TIMEOUT_MS = 3000

const readContext = (directory) => new Promise((resolve) => {
  const chunks = []
  let capturedBytes = 0
  let settled = false
  let timer

  const finish = (value) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    resolve(value)
  }

  let child
  try {
    child = spawn("code-intelligence", ["memory", "context", "--workspace", "__CODE_INTELLIGENCE_WORKSPACE__", "--max-tokens", "3000"], {
      cwd: directory,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GRAPHIFY_QUERY_LOG_DISABLE: "1",
        SERENA_USAGE_REPORTING: "false",
        NO_COLOR: "1",
      },
    })
  } catch {
    finish(undefined)
    return
  }

  child.stdout.on("data", (chunk) => {
    const remaining = MAX_CONTEXT_BYTES - capturedBytes
    if (remaining <= 0) return
    const value = Buffer.from(chunk).subarray(0, remaining)
    chunks.push(value)
    capturedBytes += value.length
  })
  child.on("error", () => finish(undefined))
  child.on("close", (code) => {
    if (settled) return
    const value = Buffer.concat(chunks).toString("utf8").trim()
    finish(code === 0 && value && value !== "No active memory." ? value : undefined)
  })

  timer = setTimeout(() => {
    try { child.kill("SIGKILL") } catch { /* fail open */ }
    finish(undefined)
  }, TIMEOUT_MS)
})

const runGuard = (directory, action, payload) => new Promise((resolve, reject) => {
  const child = spawn("code-intelligence", ["plan", action, "--workspace", "__CODE_INTELLIGENCE_WORKSPACE__"], {
    cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  })
  const stdout = []
  const stderr = []
  let bytes = 0
  const capture = (target, chunk) => { const value = Buffer.from(chunk).subarray(0, Math.max(0, MAX_GUARD_BYTES - bytes)); if (value.length) target.push(value); bytes += value.length }
  child.stdout.on("data", (chunk) => capture(stdout, chunk))
  child.stderr.on("data", (chunk) => capture(stderr, chunk))
  child.on("error", reject)
  child.on("close", (code) => {
    clearTimeout(timer)
    try {
      const result = JSON.parse(Buffer.concat(stdout).toString("utf8") || "{}")
      if (code === 0) resolve(result)
      else reject(new Error(result.reason || Buffer.concat(stderr).toString("utf8").trim() || "PlanGuard denied the operation"))
    } catch (error) { reject(error) }
  })
  const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} reject(new Error("PlanGuard timed out")) }, 5000)
  child.stdin.end(JSON.stringify(payload))
})

const mutationTargets = (event) => {
  const direct = event.input?.filePath || event.input?.file_path || event.input?.path || event.input?.file
  if (direct) return [String(direct)]
  const patch = event.input?.patchText || event.input?.patch || event.input?.diff
  if (typeof patch !== "string") return []
  return [...patch.matchAll(/^(?:\\*\\*\\* (?:Add|Update|Delete) File:|\\+\\+\\+ b\\/)(.+)$/gm)].map((match) => match[1].trim())
}

const shellCommand = (event) => typeof event.input?.command === "string" ? event.input.command : typeof event.input?.code === "string" ? event.input.code : ""
const exitCode = (event) => event.result?.metadata?.exitCode ?? event.result?.metadata?.exit_code ?? event.result?.metadata?.exitStatus?.exitCode ??
  (event.result?.output?.ok === true ? 0 : event.result?.output?.ok === false ? 1 : undefined)

export default {
  id: "code-intelligence",

  async setup(ctx) {
    try {
      const registrations = []
      registrations.push(await ctx.session.hook("compaction", async (event) => {
        try {
          const state = await readContext(ctx.location.directory)
          if (state) {
            event.system.push({
              type: "text",
              text: [
                "Code Intelligence persistent memory and active-plan state for this compaction.",
                "Preserve its objective, phase, confirmed findings, active hypotheses,",
                "open questions, blockers, relevant files/symbols, and compact current plan",
                "when relevant.",
                "",
                state,
              ].join("\\n"),
            })
          }
        } catch { /* fail open: OpenCode must continue its normal compaction */ }
      }))
      registrations.push(await ctx.tool.hook("execute.before", async (event) => {
        if (["edit", "write", "patch"].includes(event.tool)) {
          await runGuard(ctx.location.directory, "guard-before", { kind: "mutation", targets: mutationTargets(event) })
        } else if (event.tool === "execute") {
          await runGuard(ctx.location.directory, "guard-before", { kind: "shell", command: shellCommand(event) })
        }
      }))
      registrations.push(await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        if (["edit", "write", "patch"].includes(event.tool)) {
          await runGuard(ctx.location.directory, "guard-after", { kind: "mutation", targets: mutationTargets(event) })
        } else if (event.tool === "execute" && Number.isInteger(exitCode(event))) {
          await runGuard(ctx.location.directory, "guard-after", { kind: "verification", command: shellCommand(event), exit_code: exitCode(event) })
        }
      }))

      return async () => {
        for (const registration of registrations) {
          try { await registration.dispose() } catch { /* fail open during cleanup */ }
        }
      }
    } catch {
      return () => { /* fail open if hook registration is unavailable */ }
    }
  },
}
`;
