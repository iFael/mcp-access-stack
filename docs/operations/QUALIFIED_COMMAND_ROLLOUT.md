# Qualified Command Engine Rollout

## Safety baseline

The qualified command engine, safe autocorrection, shadow mode and optional provider are disabled by default. Every enabled mode requires an explicit workspace allowlist. The direct execution path remains authoritative in shadow mode.

The provider is optional. It can be enabled only with qualified execution, on Windows, with an explicit model and an absolute credential-broker path. API credentials are read through Windows Credential Manager and are never accepted through environment variables, repository files or command arguments.

## Runtime modes

Use `deploy/docker/scripts/Set-QualifiedCommandRollout.ps1` to update the private agent configuration. The script creates a timestamped backup before every change.

```powershell
# Disable every qualified-command capability
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Disabled

# Observe direct calls without changing execution
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Shadow -WorkspaceId project

# Enable qualified execution with autocorrection disabled
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Qualified -WorkspaceId project

# Enable deterministic safe autocorrection
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Autocorrection -WorkspaceId project

# Enable the optional provider independently
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Provider -WorkspaceId project `
  -ProviderModel gpt-5-mini `
  -ProviderBrokerPath C:\Private\McpCredentialBroker.exe
```

Restart the Workspace Agent after changing runtime-private configuration. Do not modify the active release contents.

## Environment bindings

The host runner derives these values from `.runtime-private/docker/<environment>/agent.json`:

- `VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED`
- `VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED`
- `VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED`
- `VS_CODE_GPT_COMMAND_PROVIDER_ENABLED`
- `VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST`
- `VS_CODE_GPT_COMMAND_PROVIDER_MODEL`
- `VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH`
- `VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS`

Invalid booleans, missing allowlists, unsafe dependency combinations or incomplete provider configuration prevent the Agent from starting.

## Sanitized observability

The Agent writes structured telemetry events to stderr. Events contain only aggregate fields such as route mode, qualification duration, plan source, diagnosis category, attempt count and postcondition status. Commands, objectives, arguments, stdout, stderr, tokens, file contents and credentials are excluded.

Operational snapshots include:

- direct, qualified and shadow call counts;
- qualification p50, p95 and maximum latency;
- plan source and diagnosis counts;
- corrections proposed, applied and blocked;
- one-attempt and two-attempt counts;
- postcondition outcomes;
- invocation registry and recipe cache metrics;
- optional provider latency, token and failure metrics.

## Release gates

Before promotion:

1. `npm run check`
2. `npm run bench:qualified-command`
3. secret scan and diff check
4. immutable release build
5. ambiente de desenvolvimento — Quick gate
6. ambiente de desenvolvimento — Candidate gate
7. two independent Stability gates
8. restart, cancellation, crash, external retry and cleanup checks

Quantitative targets:

- deterministic qualification p95 no greater than 50 ms;
- recipe-cache hit p95 no greater than 25 ms;
- zero mutable automatic reexecutions;
- zero duplicated attempts after retry or restart;
- zero secrets in logs, cache, prompts or reports.

## Rollback

The fastest rollback is configuration-only:

```powershell
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Set-QualifiedCommandRollout.ps1 `
  -Environment production -Mode Disabled
```

Restart the Workspace Agent and verify production health. If runtime health does not recover, use the preserved production release rollback procedure and restore the timestamped `agent.json.qualified-command.*.bak` configuration.

Provider rollback is independent: switch from `Provider` to `Qualified` to keep deterministic qualified execution while disabling all provider calls.
