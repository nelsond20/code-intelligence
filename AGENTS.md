# Agent Instructions

## Priority

Follow the user's explicit request, then the live tool declarations and responses, then this file. The current tool schema is authoritative. Do not reuse retired actions, fields, IDs, or workflows from older sessions, documentation, or memory.

## Tool calls

- Prefer one valid call over exploratory invalid calls. Use the declared field names, casing, enums, and payload shape. Do not add undeclared fields or wrappers.
- Never invent refs, record IDs, requirement IDs, step IDs, or verification evidence. Reuse an identifier only when the current response supplies it for the next call.
- If validation fails, follow the exact error and `next_action`; change only the invalid part. Do not repeat the same rejected shape.
- Names such as `context.find`, `memory.current`, and `plan.create` describe Code Intelligence operations. They are not necessarily the client's tool names. Use the exact tool name declared in the current session.
- When `mcp__code-intelligence__memory` or `mcp__code-intelligence__plan` is declared directly, invoke that function directly with its action payload. For example, call `mcp__code-intelligence__plan` with `{"action":"current"}` for `plan.current`.
- In clients with a deferred tool bridge, send only registered tool names. A tool search miss does not prove a directly declared tool is absent. Follow that client's live tool listing.

## Explore and read

Use Code Intelligence first for questions about code, documentation, project knowledge, or local history when it can provide the needed information. Find relevant refs, inspect the exact returned refs, and treat snippets as leads rather than proof. Use the `code-intelligence-local-docs` skill for configured `local_docs` questions and `code-intelligence-search` for other standalone lookups. A standalone lookup does not require an active memory.

Use shell, filesystem search, and Git CLI when Code Intelligence cannot provide the information or when the task requires local execution, editing, builds, or tests.

For a focused file question, locate the relevant symbol or text and read the relevant region. If the whole file is needed and is reasonably sized (about 2,000 lines or fewer), call `read_file` once with `file_path` only. Paginate only after an explicit truncation result, using useful ranges instead of many small fixed-size reads.

## Coding

- Change only what the task requires. Preserve existing structure, style, conventions, validation, guards, tests, and public contracts.
- Prefer clear names and simple control flow. Write new application code and identifiers in Spanish unless an existing interface, framework, external API, generated contract, or exact symbol requires another language.
- Do not add compatibility aliases for guessed fields or enum values.
- Do not add source-code comments, TODOs, docstrings, JSDoc, or TSDoc unless the user explicitly requests them. Preserve existing comments unless the requested change requires editing them.

## Verification and Git

- Run the narrowest relevant verification first; run broader project checks when shared behavior or contracts change. Report only checks that actually passed in this work. Recovery after an invalid call is not first-call success.
- Git is read-only unless the user explicitly requests a Git mutation. Inspection such as `status`, `diff`, `log`, `show`, `blame`, and `rev-parse` is allowed. Do not stage, commit, reset, rebase, fetch, pull, push, or otherwise change Git state without that request.

## Code Intelligence workflow

The human operator selects the active memory in the local control plane. For work tied to that memory, call the available Code Intelligence memory tool with `{"action":"current"}`. Follow the server's `stage` and `next_action`; load the suggested `required_skill` when available. A missing skill does not block the portable MCP workflow. The server owns stage transitions and the current plan step.

During investigation, use `context.find` and `context.inspect` through their currently declared tool names. Save only durable findings or questions with `memory.note`; use inspected refs as evidence and server-issued record IDs for `memory.resolve`. When the server reaches specification, set the complete desired structured spec with `memory.spec_set`.

During planning, call the available Code Intelligence plan tool with `action: "create"` and a schema-valid `steps` array derived from the active spec. Then call the same tool with `{"action":"current"}` and confirm the server-selected step. A client's native planning feature does not create this persistent plan.

Before code mutation in an active plan, call the plan tool with `{"action":"current"}`. Follow the current step and declared paths; a client without guard hooks does not mechanically enforce them. When ready, call it with `{"action":"complete_current"}`; the server checks declared changes and runs configured checks. If the step needs redesign, use `revise_current` with a reason and replacement step. Do not invent verification results or advance steps yourself.

Review remains useful after implementation steps and across the final delta when a review skill is available. A chat claim or skill invocation is not a trusted review receipt. The operator may finish a checked plan without a receipt; its final evidence records `review_status: unverified`.

Memory and plan lifecycle controls belong to the human control plane. Do not send workspace, memory, plan, or spec revision IDs in MCP requests unless the live schema explicitly requires a field.
