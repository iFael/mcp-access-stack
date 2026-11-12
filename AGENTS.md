# AGENTS.md

## Scope

These instructions apply to the entire `mcp-access-stack` repository.

## Operational state

One operational authority at a time. The cutover from the ignored `.codex/` to the Oracle-owned Central Memory is **explicit and one-way**: consult `memory_context` for the authorized MCP V3 repositoryId. Only `legacyStatus="active"` proves that the new authority was activated after verifying the original imports and an off-host recovery archive. Until then, the existing `.codex` remains canonical. After activation, Central Memory is the sole operational store; do not read, recreate, update or synchronize `.codex`. The Edge backup is for recovery, not a second live memory. If Central Memory is unavailable after activation, report that condition and reconcile its recovery; never silently fall back to a stale file.

**Only before the verified cutover**, if `.codex/` is present it must contain exactly these six canonical files:

- `CURRENT_TASK.md`
- `DECISIONS.md`
- `HANDOFF.md`
- `KNOWN_ISSUES.md`
- `NEXT_STEPS.md`
- `PROJECT_CONTEXT.md`

At the start of a task or handoff, resolve the authorized repositoryId and consult `memory_context`. If the legacy scope is not yet activated, read the six existing `.codex` files and preserve their current authority; do not treat an unavailable response as empty memory. Once activated, use Central Memory instead and retrieve historical source excerpts only when needed, labeling them unverified. Always inspect the actual Git branch, HEAD, worktree and relevant diff before changing code. Preserve pre-existing changes.

## Context and handoff policy

The MCP server does not receive a reliable ChatGPT context-window utilization percentage. Never invent or estimate a context percentage and never use tool-call count, elapsed time or request count as a proxy for token utilization.

Use deterministic operational checkpoints instead. Before cutover, update the existing `.codex` files; **after activation, use `memory_update` with idempotent operationId and exact revision CAS** for meaningful verified milestones or user-approved decisions. Native release/merge checkpoint capture is supplementary evidence, not unconditional authority. Record a checkpoint whenever a non-replayable or continuity-critical boundary is reached, including:

- a material architecture or policy decision;
- a completed implementation milestone or incident diagnosis;
- a commit, merge, release, promotion or rollback boundary;
- before an operation expected to interrupt MCP connectivity or restart a required component;
- before starting or after completing a background task that may outlive the current request;
- before leaving a dirty working tree for another chat/session;
- whenever the user explicitly requests a handoff or a new chat.

A checkpoint is state preservation, not a request to stop work. A new-chat handoff is required only when explicitly requested or when continuing in the current session is no longer reliable for reasons that are actually observable. Do not claim a hidden token threshold was reached.

## Canonical file responsibilities (legacy staging only)

- `CURRENT_TASK.md`: current objective, scope, authorization boundary and immediate state.
- `DECISIONS.md`: durable architectural and operational decisions only.
- `HANDOFF.md`: exact recoverable checkpoint, including Git/runtime state, completed work, validations and any active long-running operation identifiers.
- `KNOWN_ISSUES.md`: unresolved risks, limitations and qualified non-blockers.
- `NEXT_STEPS.md`: ordered pending gates and explicit authorization boundaries.
- `PROJECT_CONTEXT.md`: stable architecture, conventions and production baseline needed by a new session.

Before cutover, do not duplicate transient narratives across the six files. After activation, use discrete Central Memory records with provenance and revisions, and classify archived source text as `historical_unverified` until reconciled against live evidence. No parallel or shadow documentation.

## Long-running and disruptive work

Prefer persisted background-task mechanisms for commands that may outlive a synchronous request. Before retrying a mutating operation after a caller timeout/disconnect, inspect persisted task/runtime state first.

Do not restart production components, Docker, Scheduled Tasks, Windows, the Browser Worker, the Workspace Agent or the MCP transport unless the authorized task requires it and the recovery path is observable.

## Windows local companion updates

Update or roll the Windows local companion only through the official path: `prepare_release` / `promote_release`, which hand off to the `MCP V3 local updater` Scheduled Task (`Start-McpV3LocalUpdate.ps1` → `Invoke-McpV3LocalUpdateTask.ps1` → `Update-McpV3Local.ps1`). Never improvise the release switch from a command sent through the companion: no ad-hoc or elevated (`RunLevel Highest`) Scheduled Tasks, no `-ExecutionPolicy Bypass` recovery scripts, and no direct `Register-ScheduledTask`/`schtasks /Create` of companion tasks. On 2026-10-22 that improvised chain made Bitdefender Advanced Threat Control (`ATC.SuspiciousBehavior`) kill the companion `node.exe` and quarantine the active release. If the updater task is missing or uses a stale contract, ask the owner to re-run `Install-McpV3LocalUpdateTask.ps1` from the active release outside the companion. `promote_release` itself only writes `update-request.v1.json`: a second incident the same day showed that even the official handoff got the companion killed while it still enabled and started the updater task from the companion's own child process. After `promote_release` returns `handover_started`, wait: Task Scheduler starts the `MCP V3 local updater` task every 5 minutes and it applies the request, so read `get_release_state` (or the `resultPath` file) until the new release is active. Never start the task yourself. If nothing changed after 15 minutes, the task predates the 5-minute trigger: ask the owner to re-run `Install-McpV3LocalUpdateTask.ps1 -Execute -Force` from the active release outside the companion, or to run the task from Task Scheduler.

Publish a Windows companion release with `github_workflow_operation` `workflow=companion-only-distribution.yml` and `ciRunId` (the successful main CI run that built it); `get_operation_guide topic=companion` has the whole flow.

## Validation

Use the smallest validation set that proves the change. GitHub Actions remains the authority for heavy repository-wide gates when the project workflow delegates them remotely. Always review the final diff and run `git diff --check` for source changes. Never report a validation as passed unless it actually ran and passed.
