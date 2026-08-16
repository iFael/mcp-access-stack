# Minimal Windows Execution Node

## Status

Target architecture under implementation. The current production baseline remains `1.1.0-beta.8` and must stay available as rollback until the new host path passes its own cutover gates.

Stage 1 defined the release/state contracts. Stage 2 adds the remote Windows artifact build, signing and package-validation pipeline without changing the active beta.8 runtime.

## Objective

Reduce the Windows PC to the smallest trustworthy execution boundary. Anything that can be built, tested, signed, packaged or attested remotely belongs in GitHub or remote infrastructure, not in the production PC lifecycle.

The Windows machine keeps only capabilities that require local presence:

- filesystem and authorized shell access through Workspace Agent;
- MCP-owned browser automation through Browser Worker;
- local policy and credentials;
- immutable release payloads needed for active/candidate/rollback;
- one stable host/supervisor responsible for validating and running the local payload.

## Target topology

```text
GitHub
  -> CI / tests / build / signing / release manifest
  -> immutable Windows release

Remote runtime
  -> public /mcp
  -> Gateway
  -> Proxy / relay

Windows PC
  -> McpHost.exe
     |-> Workspace Agent
     `-> Browser Worker
  -> local policy / credentials / browser profile
  -> releases/<version>
  -> active / candidate / previous state
```

Gateway, Proxy and public exposure are intended to move off the Windows PC in a later migration gate. The first implementation gates do not change current production networking.

## Trust boundaries

### GitHub responsibilities

GitHub is authoritative for:

- source checkout from an immutable commit;
- dependency restore;
- lint, tests and build;
- native Windows compilation;
- Authenticode signing of executable MCP components;
- SHA-256 generation;
- immutable release manifest generation;
- release packaging and publication;
- GHCR image production while Gateway/Proxy remain part of the release model.

The production PC must not compile MCP executables.

### Windows responsibilities

The Windows node may:

- fetch an explicitly eligible release;
- verify release identity, manifest and SHA-256;
- verify Authenticode for executable MCP components;
- materialize immutable release files;
- mark a release as candidate;
- promote an explicitly authorized candidate;
- supervise Workspace Agent and Browser Worker;
- perform health/readiness checks;
- roll back to a previously validated release;
- read local policy and protected credentials.

The Windows node must not:

- run `npm install`, `npm build`, `docker build` or C# compilation as part of production installation/promotion;
- generate executable MCP binaries dynamically;
- accept arbitrary privileged scripts from a release;
- use Git state as the production release authority;
- mutate source code during update or promotion;
- weaken endpoint protection as part of normal operation.

## McpHost boundary

`McpHost.exe` is the intended single permanent local bootstrap and supervisor.

Its stable responsibilities are limited to:

1. load local configuration;
2. validate the selected immutable release;
3. validate hashes and required Authenticode signatures;
4. launch Workspace Agent;
5. launch Browser Worker;
6. supervise child lifecycle and expose health/readiness;
7. stage a verified candidate without changing active production;
8. promote only after an explicit authorization boundary;
9. restore the previous release if the candidate fails post-cutover gates.

`McpHost.exe` must not contain a general-purpose privileged script runner.

The Stage 2 binary is intentionally non-operational as a supervisor. It accepts only `--version` and `--validate-release-root`; supervision is implemented only in its dedicated later gate.

## Release layout

The versioned contract is defined in `packages/mcp-core/src/windows-execution-node-contracts.ts`.

Transitional `bundled-node` release layout:

```text
releases/<release-id>/
  manifest.json
  execution-node-manifest.json
  native/
    McpHost.exe
  compat/
    McpNodeHostLauncher.exe
    McpCredentialBroker.exe
  services/
    workspace-agent/dist/cli.js
    browser-worker/dist/server.js
  runtime/
    node/
      node.exe
      ...
```

The first supported runtime mode is `bundled-node`: Node is part of the immutable release instead of being independently downloaded or managed on the PC.

The `compat/` executables are transitional only. Prebuilding and signing them remotely lets a later gate remove local `csc.exe` compilation before the final single-host cutover is ready. They are not part of the final topology.

The contract also reserves `self-contained` for a later qualified implementation where Workspace Agent and Browser Worker no longer need a separate Node runtime. That mode must not be enabled by production code until Playwright and all native dependencies are proven compatible.

## Artifact contract

Every Windows execution manifest contains:

- contract version;
- release ID;
- exact source commit;
- platform (`win32-x64`);
- creation timestamp;
- runtime mode;
- artifact role, relative path, SHA-256, byte size and signature requirement.

Required component roles:

- `mcp-host`;
- `workspace-agent`;
- `browser-worker`.

`bundled-node` additionally requires `node-runtime`.

The contract rejects:

- absolute artifact paths;
- traversal paths;
- duplicate roles;
- missing required components;
- a `McpHost.exe` that does not require Authenticode validation;
- inconsistent runtime mode declarations.

Workspace Agent and Browser Worker remain Node payloads during the `bundled-node` transition. Their entrypoints are SHA-256 bound to `execution-node-manifest.json`, which is itself bound to the signed release attestation and signed distribution manifest. They are not falsely modeled as PE files requiring embedded Authenticode. `McpHost.exe` is file-level Authenticode signed with the pinned MCP code-signing certificate.

## Stage 2 remote artifact pipeline

The public release workflow builds native execution-node artifacts on `windows-latest` before the signing step:

```text
GitHub Windows runner
  -> New-McpRelease.ps1
  -> New-McpWindowsExecutionNodeArtifacts.ps1
     |-> McpHost.exe
     |-> McpNodeHostLauncher.exe (compatibility only)
     `-> McpCredentialBroker.exe (compatibility only)
  -> New-McpPublicDistribution.ps1
     |-> bundle managed Node runtime into the immutable release
     |-> Authenticode-sign MCP native executables
     |-> generate execution-node-manifest.json
     |-> bind it into manifest.json
     |-> generate signed release-attestation.ps1
     `-> generate signed distribution-manifest.ps1
  -> Test-McpWindowsExecutionNodePackage.ps1
  -> publish ZIP + SHA-256
```

The package-validation gate recalculates critical hashes and sizes, validates the pinned Authenticode signer where required, validates signed compatibility helpers, executes `McpHost --validate-release-root`, and verifies the bundled `node.exe --version` against the immutable release manifest.

## State model

The host state is versioned and separates:

- `active`: currently running release;
- `candidate`: verified release prepared for a future cutover;
- `previous`: last known release retained for rollback.

Each pointer binds the release ID to the SHA-256 of its manifest. Candidate materialization never changes `active`.

Promotion is a separate transaction:

```text
verify candidate
  -> stop children
  -> select candidate as active
  -> start Workspace Agent
  -> readiness
  -> start Browser Worker
  -> readiness
  -> commit previous pointer
```

If a post-cutover gate fails, the host restores the previous validated release before reporting terminal failure.

## Local state that remains essential

Mutable machine-specific state remains outside immutable releases:

```text
%LOCALAPPDATA%/McpAccessStack/
  policy/
  state/
  credentials/
  logs/
  browser/
```

Secrets are never part of GitHub Release assets or release manifests.

The dedicated Browser Worker profile remains persistent and MCP-owned.

## Migration strategy

The migration is additive until cutover is proven:

1. define and test release/state contracts;
2. produce native artifacts in GitHub;
3. add `McpHost` without replacing beta.8 runtime;
4. stage releases through the new contract;
5. validate host supervision in parallel;
6. implement transactional promotion/rollback;
7. cut over local persistence to the single host;
8. remove local compilation/runtime-tool legacy only after successful observation;
9. move Gateway/Proxy/public exposure off the PC;
10. remove Docker/WSL/tunnel from the local operational path when remote routing is proven.

At no point should the beta.8 rollback path be removed before the replacement path is independently recoverable.

## ATC mitigation objective

This architecture intentionally removes the behavior that triggered the beta.8 Bitdefender ATC false positive from the normal production lifecycle:

```text
PowerShell -> csc.exe -> new unsigned EXE -> Scheduled Task -> Launcher -> Node
```

The target lifecycle is conventional software deployment:

```text
signed immutable release -> verify -> McpHost.exe -> verified child components
```

Endpoint protection remains enabled; the architecture must adapt to the endpoint security boundary rather than depend on exclusions.

## Candidate-only staging (Stage 3)

The first local materialization path is deliberately separate from the legacy updater and from production activation. `Stage-McpWindowsExecutionNodeCandidate.ps1` accepts an already extracted public distribution plus an explicit installation root; it does not fetch from GitHub, import Docker images, request promotion or start `McpHost`.

The managed layout is:

```text
<installation-root>/
  releases/
    <release-id>/
  state/
    execution-node.json
    state.lock
```

`execution-node.json` implements the versioned `active` / `candidate` / `previous` contract. Stage 3 may create or replace only `candidate`; `active` and `previous` are preserved semantically unchanged and staging the current active release is rejected. `manifestSha256` binds the pointer to `execution-node-manifest.json`.

The candidate transaction is fail-closed:

```text
signed distribution manifest
  -> validate every distribution hash and reject unsigned extra files
  -> validate release attestation + manifest hashes
  -> validate execution-node manifest + critical artifacts
  -> validate required Authenticode
  -> reject reparse points
  -> reject overlapping source/destination roots
  -> acquire exclusive state lock
  -> copy to releases/.staging-*
  -> revalidate copied release
  -> atomic directory move to releases/<release-id>
  -> revalidate final release
  -> atomically write candidate state
  -> report READY
```

The signed distribution file set is revalidated after materialization, including dependencies outside the smaller release `fileHashes` set, closing the copy-time TOCTOU window.

A retry is idempotent when the same release and execution manifest are already materialized. An existing target with a different identity fails closed. A failed copy/validation can leave no candidate pointer; a successfully materialized release with a failed state write is harmless and can be revalidated on retry.

The stager itself and `WindowsExecutionNode.Common.ps1` are included in the public distribution and Authenticode-signed by the GitHub packaging job. `AllowUnsignedDevelopment` exists only for repository tests/fixtures and does not relax normal production verification.

Stage 3 does not modify the beta.8 production runtime, Scheduled Tasks, `.runtime-tools`, Docker, Gateway, Proxy, Tunnel or endpoint-security configuration.

## McpHost supervision and health (Stage 4)

Stage 4 evolves `McpHost.exe` from a release-contract smoke artifact into the fixed local supervisor for Workspace Agent and Browser Worker. It does not activate the host in production and does not change `active`/`candidate`/`previous`.

The supervisor command is deliberately closed rather than generic:

```text
McpHost.exe --supervise
  --release-root <validated release>
  --project-root <local MCP root>
  --environment <development|production>
  --expected-manifest-sha256 <candidate/active manifest hash>
```

Only bounded lifecycle/readiness tuning and an optional credential-broker path are accepted. The host does not accept arbitrary executable paths, command strings, shell names or script runners.

Before starting children, the host:

1. validates the fixed `bundled-node` execution manifest contract;
2. binds startup to the expected SHA-256 of `execution-node-manifest.json`;
3. revalidates size and SHA-256 for `McpHost.exe`, Agent, Browser Worker and bundled `node.exe`;
4. requires the `mcp-host` artifact record to remain Authenticode-required;
5. resolves only fixed child paths inside the release;
6. reads the existing private Agent/Browser configuration without logging secrets.

The child topology is direct:

```text
McpHost.exe
  |-> runtime/node/node.exe services/workspace-agent/dist/cli.js connect ...
  `-> runtime/node/node.exe services/browser-worker/dist/server.js
```

`Run-DockerHostComponent.mjs` is not part of the new supervision path.

Readiness is component-specific:

- Workspace Agent becomes ready only after its structured stderr diagnostic emits `event=connected`; reconnect/disconnect diagnostics can move it back to degraded without creating a second process;
- Browser Worker is polled only on loopback `GET /health/ready` and is ready only on HTTP 200;
- each newly started child has a bounded initial-readiness deadline; after a child has become ready, transient readiness loss does not immediately force a restart;
- process exit uses a bounded restart budget and interval; exhaustion is terminal for the execution node.

All supervised child processes are assigned to one Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Closing or terminating the host therefore closes the execution tree instead of leaving detached Agent/Browser descendants.

Operational health is written as sanitized local state under:

```text
runtime/windows-execution-node/<environment>/host-state.json
```

The state exposes host status, release identity, execution-manifest hash, child PIDs, live/ready flags, restart attempts and timestamps. It never writes Agent/Browser tokens or credential values.

The GitHub-only runtime smoke compiles the native host on the Windows runner, runs fake fixed Agent/Browser payloads from a fixture release, verifies Browser HTTP readiness, Agent structured readiness, one bounded Agent restart, final host readiness and Job Object cleanup after host termination. Normal local checks remain source/static only and do not invoke `csc.exe`.

Stage 4 remains additive: beta.8 Scheduled Tasks, Agent, Browser Worker and production routing stay untouched until a later promotion/rollback gate explicitly authorizes cutover.

## Transactional promotion and rollback (Stage 5)

Stage 5 introduces a state transition controller without changing the beta.8 production runtime. The controller uses the same `state/state.lock` owned by candidate staging, so staging, promotion and rollback are mutually exclusive.

The transition model is explicit:

```text
PROMOTE
active=A, candidate=B, previous=null
  -> validate A and B
  -> start B with McpHost
  -> require B health=ready
  -> active=B, previous=A, candidate=null

ROLLBACK
active=B, candidate=null, previous=A
  -> validate B and A
  -> start A with McpHost
  -> require A health=ready
  -> active=A, candidate=B, previous=null
```

The displaced active release becomes `candidate` after rollback so it can only return to active through a new health-qualified promotion. Rollback does not create an implicit toggle loop through `previous`.

The state write is deliberately late. `active` is never changed before the target release has passed:

1. pointer validation;
2. materialized release validation;
3. execution-manifest hash binding;
4. critical artifact validation performed by `McpHost` at startup;
5. Agent readiness;
6. Browser Worker readiness;
7. host health identity checks (`releaseId`, manifest SHA-256, environment and host PID).

If validation, process startup or health fails, the qualification host is terminated and `execution-node.json` is not rewritten. This makes a failed promotion or rollback a no-state-change outcome rather than a compensating pointer rewrite.

Qualification startup also passes the transition controller PID through the closed `--qualification-owner-pid` option. `McpHost` holds a process handle for that owner; if the controller disappears before normal teardown, the host signals shutdown and closes its Job Object, preventing a pre-commit qualification tree from becoming orphaned.

`Invoke-McpWindowsExecutionNodeTransition.ps1` is intentionally not the Stage 6 cutover orchestrator. Its McpHost instance is qualification-owned and is terminated after the state transaction. Persistent host ownership, stopping the beta.8 Scheduled Tasks and reboot persistence remain a separate cutover gate.

Before qualification, the transition controller also refuses to run when `host-state.json` identifies a live McpHost. Stage 6 must therefore stop the currently owned host/runtime explicitly before invoking a real transition; Stage 5 never kills an existing production host implicitly.

The transition script is included in the signed public Windows distribution. Normal local checks validate only its static contract. GitHub Windows CI owns the runtime smoke that compiles the native host and proves healthy promotion, healthy rollback, health-failure state preservation, pointer-tamper rejection and `state.lock` serialization.

## Persistent host ownership and cutover orchestration (Stage 6)

Stage 6 introduces the persistent ownership model but does not execute a real production cutover. `McpHost.exe` advances to `mcp-host-contract-v3` and adds the closed `--run-active` command. The persistent command does not accept an executable, shell or script path. It resolves only the active execution-node release from the installation state.

The stable local layout is:

```text
<installation-root>/
  host/
    McpHost.exe
  releases/
    <release-id>/...
  state/
    execution-node.json
    state.lock
    host-ownership-<environment>.lock
```

The stable host path is intentionally outside a versioned release. A per-user Scheduled Task points directly to `<installation-root>/host/McpHost.exe --run-active ...`; it does not point to `McpNodeHostLauncher.exe`, PowerShell, `Run-DockerHostComponent.mjs` or another generic runner. The task uses the interactive current-user session, Limited run level, `AtLogOn`, `MultipleInstances=IgnoreNew` and Task Scheduler restart policy. This preserves Browser Worker access to the interactive desktop/profile while reducing Agent + Browser persistence from two Tasks to one host owner.

At `--run-active` startup, `McpHost`:

1. requires its own process image to be exactly the stable host path;
2. acquires an exclusive `host-ownership-<environment>.lock` for its lifetime;
3. reads only the versioned `active` pointer from `state/execution-node.json`;
4. resolves and revalidates `releases/<active.releaseId>` against the pointer manifest SHA-256;
5. requires the stable `McpHost.exe` SHA-256 to match `native/McpHost.exe` from that active release;
6. only then enters the existing Agent/Browser supervisor.

A second persistent McpHost for the same environment therefore fails before it can spawn another Agent or Browser tree.

### Lifecycle serialization

`state.lock` remains the canonical lock for execution-node state mutation. Stage 6 adds a wider named lifecycle mutex derived from the normalized installation root. Candidate staging, Stage 5 transition and Stage 6 cutover acquire this mutex. The cutover owns it for the full stop/qualify/state/sync/start/health window, while the synchronous Stage 5 transition re-enters the same mutex on the same thread. This prevents a concurrent staging or transition operation from changing the lifecycle while ownership is being transferred.

### Cutover order

The Stage 6 orchestrator is deliberately separate from the Stage 5 state transition:

```text
capture current ownership + exact state snapshot
  -> stop previous persistent host, if any
  -> stop + disable legacy Agent/Browser Tasks
  -> Stage 5 health-qualified state transition
  -> copy + verify active release McpHost to the stable host path
  -> ensure/enable the single persistent host Task
  -> start Task
  -> require persistent McpHost + Agent + Browser ready
  -> report cutover-ready
```

The legacy Tasks are disabled, not removed. Launcher, Credential Broker and `.runtime-tools` also remain untouched in Stage 6.

### Failure recovery

The first migration from beta.8 is special: beta.8 is the external legacy runtime and is not represented as an execution-node `previous` release. Stage 6 therefore never invents a beta.8 pointer. If the first cutover fails after a new-format state transition, the orchestrator restores the exact pre-cutover state snapshot and restores the enabled/running state of the two legacy beta.8 Tasks.

For a later cutover where a persistent McpHost was already the owner, failure similarly restores the exact pre-cutover execution-node state and restarts that prior persistent owner. Exact snapshot restoration is used instead of an inverse state transition so an older `previous` pointer is not lost.

Stage 6 tests actual Scheduled Task mutation only on the GitHub Windows runner. The CI smoke proves direct stable-task ownership, duplicate-host rejection, stop/start (reboot-equivalent) recovery and fallback to legacy ownership after a deliberately failed first cutover. Normal local checks remain static/parser-only and never create Tasks or invoke `csc.exe`.

Stage 6 still does not authorize production cutover or legacy removal. A later explicit production gate is required before changing the real beta.8 Tasks, installing the stable host on the workstation, or deleting Launcher/Broker/`.runtime-tools` artifacts.
