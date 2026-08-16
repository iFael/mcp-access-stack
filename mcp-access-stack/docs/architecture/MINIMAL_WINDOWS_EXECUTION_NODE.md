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
