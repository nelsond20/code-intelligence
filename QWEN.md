# Code Intelligence dispatcher

For Code Intelligence work, call `memory.current` to resume persisted state. Obey the server's `required_skill` and load the matching stage skill. The server derives the stage and owns current step advancement.

`plan` means the persistent Code Intelligence MCP tool. Never substitute Qwen native Plan Mode, prose, or TodoWrite for it. Before any code mutation, call `plan.current`; mutate only when a valid, non-stale current implementation step authorizes the path.

Invoke the installed `code-review-and-quality` skill after verification for every implementation step and again for cumulative final review. Resolve blocking findings and repeat affected verification and review after changes. A review claim in chat is not an external review receipt.
