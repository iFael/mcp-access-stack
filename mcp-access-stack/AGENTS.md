# AGENTS.md

## Scope

These instructions apply to the entire `mcp-access-stack` repository.

## Operational state

Local operational state for ChatGPT work lives only in the ignored `.codex/` directory. Do not commit `.codex` and do not create parallel state files.

When `.codex/` is present, it must contain exactly these six canonical files:

- `CURRENT_TASK.md`
- `DECISIONS.md`
- `HANDOFF.md`
- `KNOWN_ISSUES.md`
- `NEXT_STEPS.md`
- `PROJECT_CONTEXT.md`

At the start of a task or after a chat/session handoff, read those six files before changing the repository, then inspect the current Git branch, HEAD, working tree and relevant diff. Preserve pre-existing local changes.

## Context and handoff policy

The MCP server does not receive a reliable ChatGPT context-window utilization percentage. Never invent or estimate a context percentage and never use tool-call count, elapsed time or request count as a proxy for token utilization.

Use deterministic operational checkpoints instead. Update the existing `.codex` files whenever a non-replayable or continuity-critical boundary is reached, including:

- a material architecture or policy decision;
- a completed implementation milestone or incident diagnosis;
- a commit, merge, release, promotion or rollback boundary;
- before an operation expected to interrupt MCP connectivity or restart a required component;
- before starting or after completing a background task that may outlive the current request;
- before leaving a dirty working tree for another chat/session;
- whenever the user explicitly requests a handoff or a new chat.

A checkpoint is state preservation, not a request to stop work. A new-chat handoff is required only when explicitly requested or when continuing in the current session is no longer reliable for reasons that are actually observable. Do not claim a hidden token threshold was reached.

## Canonical file responsibilities

- `CURRENT_TASK.md`: current objective, scope, authorization boundary and immediate state.
- `DECISIONS.md`: durable architectural and operational decisions only.
- `HANDOFF.md`: exact recoverable checkpoint, including Git/runtime state, completed work, validations and any active long-running operation identifiers.
- `KNOWN_ISSUES.md`: unresolved risks, limitations and qualified non-blockers.
- `NEXT_STEPS.md`: ordered pending gates and explicit authorization boundaries.
- `PROJECT_CONTEXT.md`: stable architecture, conventions and production baseline needed by a new session.

Do not duplicate the same transient narrative across all six files. Put each fact in the file whose responsibility owns it and reference durable facts compactly from the others when needed.

## Long-running and disruptive work

Prefer persisted background-task mechanisms for commands that may outlive a synchronous request. Before retrying a mutating operation after a caller timeout/disconnect, inspect persisted task/runtime state first.

Do not restart production components, Docker, Scheduled Tasks, Windows, the Browser Worker, the Workspace Agent or the MCP transport unless the authorized task requires it and the recovery path is observable.

## Validation

Use the smallest validation set that proves the change. GitHub Actions remains the authority for heavy repository-wide gates when the project workflow delegates them remotely. Always review the final diff and run `git diff --check` for source changes. Never report a validation as passed unless it actually ran and passed.
