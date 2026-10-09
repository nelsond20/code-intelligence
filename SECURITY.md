# Security

## Trust boundaries

Code Intelligence reads registered repository roots and writes only its configuration, indexes, memory/plan state, and explicitly managed OpenCode integration files. The public MCP surface contains exactly `context.find`, `context.inspect`, `memory`, and `plan`; there is no arbitrary filesystem path, shell, subprocess, edit, or Git command tool.

Configured docs/vault HTTP MCP backends remain internal broker sources. Their endpoints pass through the same network policy, bearer credentials are loaded from token files at runtime, and token values are redacted from errors and normalized results.

Repository paths are canonicalized. Absolute read paths, `..` traversal, non-files, and symlinks escaping a registered root are rejected. Security ignore rules exclude `.git`, dependencies/build caches, `.env*`, private keys, SSH keys, credentials, common binaries, and project `.codeintelligenceignore` data where applicable. Source reads are bounded.

## Read-only Git

Git is an internal broker backend. Its API consists of structured history search, commit summary/diff, file diff, blame, and status functions. Revisions must be hexadecimal commit IDs for inspection; paths reject absolute/traversal/options and secret patterns. Commands use fixed argument templates with no shell, pager, external diff, textconv, hooks, or file protocol. No fetch, pull, push, clone, remote, checkout, reset, branch/tag mutation, merge, rebase, commit, add, or generic model-controlled argument interface exists.

Read-only Git describes what changed. Code retrieval and relationship engines provide bounded hints about what a change may affect. Neither subsystem automatically writes semantic conclusions into persistent memory.

## Local services and network

The default `loopback-only` policy accepts only literal `127.0.0.0/8` and `::1` HTTP(S) endpoints for embeddings. Hostnames and credentials embedded in URLs are rejected. No cloud embedding provider, update checker, telemetry exporter, or remote logger is included.

`local-docs` and `vault-retrieval` are optional existing local stdio MCP processes. Graphify and Serena are optional local subprocesses. Child environments remove common cloud/API credentials, force `GRAPHIFY_QUERY_LOG_DISABLE=1` and `SERENA_USAGE_REPORTING=false`, and expose only narrow read/navigation adapters. Their edit/shell surfaces are never forwarded.

## Persistence and concurrency

Memory and plan files use restrictive directories/files, atomic rename writes, schema validation, per-workspace/file locks, last-valid backups, and a recoverable transaction journal for related state/spec/findings changes. `plan.json` contains bounded execution state, not prompts, source chunks, Docs/Vault payloads, credentials, or reasoning. OpenCode PlanGuard uses verified `execute.before`/`execute.after` hooks, real pre/post content manifests, and a functional heartbeat to reject out-of-step editor targets and indirect shell mutation bypasses while a plan is active. Installer edits are previewable, idempotent, backed up, comment-preserving, and limited to owned entries/markers.

Report suspected vulnerabilities without including repository source, prompts, credentials, or memory/plan contents in public issues.
