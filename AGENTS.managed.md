<!-- CODE_INTELLIGENCE_BEGIN -->
## Local context broker, memory, and guarded plans

- **FIND:** Use `context.find` to discover relevant code, docs, or personal knowledge.
- **INSPECT:** Use `context.inspect` for exact content, surroundings, references, or relations from a discovered ref.
- Refs are opaque broker handles. Pass them exactly as returned by `context.find`; never decode, reconstruct, edit, or guess them. Ephemeral refs may require repeating `context.find` after restart or eviction.
- **MEMORY:** Use `memory` as persistent work memory. Call `memory current` when resuming substantial work. Record durable observations, evidence, hypotheses, decisions, questions, blockers, and relevant context early. The confirmed spec belongs to memory.
- **PLAN:** When an active plan exists, call `plan current` to learn the server-owned current step. Do not work ahead or modify paths outside that step. Request `plan complete` only after required verification. Use `plan revise` with a reason instead of silently deviating.
- The MCP workspace is configured by the host. Never pass or guess a workspace ID. Use `scope` only to restrict Code/Git discovery to a repository inside that workspace; Docs and Vault ignore it.
- For change review, use read-only Git or broker Git inspection to determine what changed, then `context.find`/`context.inspect` to determine impact. Prefer summary/file views over large diffs.
- Context inspection may record inspected refs, files, symbols, and commits mechanically. Use `memory` notes for semantic findings, hypotheses, decisions, and conclusions.
<!-- CODE_INTELLIGENCE_END -->
