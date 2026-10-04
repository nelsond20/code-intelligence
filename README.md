# Code Intelligence

Code Intelligence is a local **Context Broker + Persistent Work Memory + Guarded Plan** for OpenCode and local models. It keeps durable work context across sessions and compactions, retrieves small relevant slices from multiple repositories, and presents exactly four MCP tools:

- `context.find` discovers code, local documentation, vault knowledge, and Git history.
- `context.inspect` deepens an opaque broker reference with bounded content, surroundings, relationships, commit summaries, diffs, or blame.
- `memory` manages persistent semantic work memory and the confirmed specification.
- `plan` controls an optional spec-bound ordered execution plan.

The default configuration sends no source, prompts, queries, embeddings, analytics, or telemetry to remote services.

## Architecture

```text
OpenCode / Ornith
  └─ context.find | context.inspect | memory | plan
       └─ local Context Broker
            ├─ code: lexical + local semantic + Graphify/Serena fallbacks
            ├─ docs: existing local-docs MCP (optional)
            ├─ vault: existing vault-retrieval MCP (optional)
            ├─ git: structured read-only history/diff/blame
            └─ persistent memory, plan state, and OpenCode PlanGuard
```

Repositories stay in their original locations. Semantic indexes contain vectors and location/hash metadata, not a second source-code copy. Task files live outside repositories under `~/.local/share/code-intelligence` by default.

## Install

Requirements: Node.js 22+, npm, and preferably `rg` and a functional Git installation.

```bash
npm install
npm run build
npm link
```

Create and inspect the default config with:

```bash
code-intelligence workspace list
code-intelligence doctor
```

The config is created on the first registry change at `~/.config/code-intelligence/config.toml`. Defaults enforce loopback-only model endpoints and disable telemetry, analytics, and query logging.

## Register three repositories

```bash
code-intelligence workspace add planning \
  --repo /absolute/path/to/frontend \
  --repo /absolute/path/to/backend \
  --repo /absolute/path/to/shared
```

Repository IDs derive deterministically from directory names. Additional repository management is available through `workspace repo-add <workspace> --path <path> [--id <id>]` and `workspace repo-remove <workspace> <repo-id>`.

Set the workspace for CLI/MCP sessions that cannot infer it from their working directory:

```bash
export CODE_INTELLIGENCE_WORKSPACE=planning
```

The public MCP tools do not accept a workspace argument. The MCP process validates this environment value and uses it internally for all four tools. CLI commands remain multi-workspace and continue accepting `--workspace`.

## Local semantic indexing

The default provider is local Ollama at `http://127.0.0.1:11434` with `qwen3-embedding:4b`. Its request timeout is configurable:

```toml
[embeddings]
enabled = true
provider = "ollama"
base_url = "http://127.0.0.1:11434"
model = "qwen3-embedding:4b"
timeout_ms = 60000
batch_max_texts = 32
batch_max_tokens_estimate = 7000
```

An OpenAI-compatible local llama.cpp server can be selected without changing the default Ollama integration:

```toml
[embeddings]
enabled = true
provider = "llamacpp"
base_url = "http://127.0.0.1:11435"
model = "qwen3-embedding-4b"
timeout_ms = 120000
batch_max_texts = 32
batch_max_tokens_estimate = 7000
```

llama.cpp requests use `POST /v1/embeddings` and batch multiple source chunks per request. Batches are flushed at either configured limit. Token usage is conservatively estimated as UTF-8 bytes plus per-text special-token headroom. The indexer splits oversized chunks at blank lines, source declarations, line boundaries, or finally Unicode code-point boundaries, while preserving source ranges and stable content identities. A residual oversized direct input is rejected before network I/O. `batch_max_texts` cannot exceed 32. Both providers remain subject to `privacy.network_policy`; the default `loopback-only` policy rejects non-loopback endpoints.

```bash
code-intelligence index --workspace planning
code-intelligence index --workspace planning --repo backend --force --progress
```

Pass `--progress` to render per-repository embedding progress, throughput, reused chunks, and estimated time remaining on stderr. The final JSON result remains on stdout for scripts and redirection.

If the configured embedding provider is unavailable, `context.find` degrades to lexical retrieval. Tests mock embeddings and do not require a service. Non-loopback endpoints are rejected while `network_policy = "loopback-only"`.

## Optional local sources

Existing `local-docs` and `vault-retrieval` services are internal broker adapters, not reimplementations or public tools. Their direct OpenCode configuration is never deleted or disabled by this installer. Existing Streamable HTTP MCP servers can be configured as follows:

```toml
[local_docs]
enabled = true
transport = "http"
url = "http://127.0.0.1:8000/mcp"
timeout_ms = 7000
search_tool = "docs.search"

[vault]
enabled = true
transport = "http"
url = "http://127.0.0.1:8123/mcp"
timeout_ms = 7000
search_tool = "search"
inspect_tool = "read_note"
token_file = "/Users/example/.config/opencode/secrets/vault-retrieval-token"
```

Local Docs retrieval is deliberately asymmetric: `context.find` calls `docs.search`, which already returns document content and metadata, and the broker retains a bounded in-memory copy behind each deterministic `docs://` ref. `context.inspect(view="content")` reads that retained result without calling a nonexistent Docs read tool. Vault remains `search` for discovery and `read_note` for inspection. `docs.sources` is corpus inventory/diagnostic metadata and is not part of the find/inspect path. The Local Docs and Vault projects themselves are not modified.

For managed subprocesses, set `transport = "stdio"` and `command = "..."` instead. HTTP MCP URLs are checked by `privacy.network_policy`; under the default policy only literal loopback addresses are accepted. Bearer token contents are read from `token_file` for each runtime session, are never serialized into Code Intelligence configuration or results, and are redacted from adapter errors.

If either process is absent or fails, results from healthy sources are still returned. `timeout_ms` is configured independently for Local Docs and Vault. Graphify and Serena are also optional internal engines with their own `timeout_ms`; their child environments strip cloud credentials and disable query/usage reporting.

## OpenCode integration

Preview, install, and verify:

```bash
code-intelligence install-opencode --dry-run
code-intelligence install-opencode --yes
code-intelligence doctor
```

The installer detects direct `mcp` versus `mcp.servers`, preserves JSONC comments, backs up changed files, adds one local stdio MCP, manages only a delimited section in global `AGENTS.md`, and installs OpenCode V2 compaction and tool-execution hooks. Compaction appends bounded memory plus only the active plan summary. PlanGuard checks editor targets before execution, blocks detectable shell/code file mutation bypasses, and records mutation/verification generations after successful tool execution. The installer does not alter model/provider settings or silently remove existing Local Docs/Vault entries.

Recommended OpenCode tuning (documented, not applied automatically):

```jsonc
"compaction": { "auto": true, "keep": { "tokens": 8000 }, "buffer": 8192, "prune": true },
"tool_output": { "max_lines": 200, "max_bytes": 8000 }
```

For Ornith, use context `90112` and output `8192`. This project does not change llama.cpp settings.

## Typical workflow

For substantial work, call `memory` with `action: "new"`, then use `context.find` and `context.inspect`. Record durable meaning with `memory(action="note")` and resolve records by server ID. Manage structured requirements with `spec_replace`, `spec_patch`, or `spec_rollback`. For guarded work, create a coverage-checked plan, call `plan(action="current")`, work only in the current write set, verify it, and request `plan(action="complete")`. Use structured `plan(action="revise")` operations instead of silently deviating; suspend/reactivate/abandon are explicit lifecycle transitions.

Memory lifecycle from the CLI:

```bash
code-intelligence memory new "Planning duration correction" --workspace planning --objective "Correct duration behavior"
code-intelligence memory current --workspace planning
code-intelligence memory pause --workspace planning
code-intelligence memory activate planning-duration-correction --workspace planning
code-intelligence memory complete --workspace planning
code-intelligence plan current --workspace planning
```

Each work item stores schema-v2 `state.json`, curated `findings.md`, structured `spec.json`, immutable spec revisions, a human `spec.md`, a transaction journal, and optional `plan.json`. The old `task` CLI namespace remains a deprecated compatibility alias; there is no public MCP `task` tool.

## Git behavior

Git is internal to the broker, never a separate MCP tool. History search uses bounded local `git log` message and pickaxe queries. Inspection returns commit metadata and changed files before any patch. `view=diff` is bounded; file references allow narrower follow-up inspection. Only status/log/show/diff/blame-style reads exist. There is no raw command API, mutation operation, hook execution, or remote Git operation.

## Troubleshooting and degraded mode

- `doctor` reports required failures and optional degraded capabilities.
- If semantic retrieval is down, lexical code results still work.
- If Graphify or Serena is absent, local symbol/relation fallbacks are used.
- If docs or vault is absent, other sources still return results.
- If Git is unavailable, code/docs/vault/memory/plan functionality remains usable.
- Set `CODE_INTELLIGENCE_CONFIG`, `CODE_INTELLIGENCE_DATA_DIR`, or `OPENCODE_CONFIG_DIR` to override local paths.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run benchmark:prepare
```

Tests cover memory and plan restart, spec staleness, verification generations, PlanGuard interception, broker fail-open behavior, path/symlink boundaries, secret exclusion, Git safety, installer idempotence, privacy policy, and the exact four-tool MCP surface.

The model benchmark is documented in [docs/BENCHMARK.md](docs/BENCHMARK.md).
Preparation creates isolated local fixtures but never invokes a model; endpoint
access must be authorized separately.

## Uninstall OpenCode integration

```bash
code-intelligence uninstall-opencode --dry-run
code-intelligence uninstall-opencode --yes
```

Only owned MCP configuration, managed AGENTS content, and the managed plugin are removed. Repositories, memory/plan state, indexes, existing local services, and unrelated OpenCode configuration are preserved.
