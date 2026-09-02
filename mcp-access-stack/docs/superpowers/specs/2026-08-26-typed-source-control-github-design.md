# Typed Git/GitHub Source-Control for MCP GPT V3 — Design

Status: APPROVED ARCHITECTURE - WRITTEN SPEC APPROVED 2026-08-31

## Provenance

This document evolves the reconstituted 2026-08-26 Typed Git/GitHub design for the current Daily Operational Hardening Phase 4.

The historical design approved a closed V1 surface of nine source-control tools. The current `.codex` roadmap is newer and explicitly requires typed unstage and local merge operations in addition to stage, commit, branch creation, push and GitHub/PR operations. This revision therefore does not claim byte-identical historical recovery and does not pretend the old nine-tool and current eleven-tool scopes are identical.

Historical canonical path:
`docs/superpowers/specs/2026-08-26-typed-source-control-github-design.md`

Historical recovered design SHA-256 before this revision:
`054df34c8bf0887323175c4f59a47ef27d6f77f33cedfd1e3337145553a95d65`

Current implementation boundary:
`runtime/source-worktrees/daily-operational-hardening-phase1/mcp-access-stack`

Current cumulative branch:
`feat/daily-operational-hardening-phase1`

Phase 3 local HEAD at Phase 4 opening:
`950c504fc421cc756636d12f89dd57ae118bcd59`

The Phase 1 remote snapshot remains at:
`2704b473a89fed349921201238730f4a04145478`

No further push, PR, merge, deploy, restart or cutover is part of this design update.

## 1. Objective

Add an official, typed, least-privilege Git/GitHub source-control surface to MCP GPT V3 so ChatGPT can perform the repository operations needed in daily engineering work without falling back to arbitrary shell execution or unrestricted GitHub command/API surfaces.

Runtime path:

`ChatGPT -> typed MCP tools -> MCP Core -> Gateway/Relay -> Workspace Agent -> typed Git/GitHub services`

Local Git mutations and GitHub remote/API mutations remain separate trust domains and separate executor ports.

The Phase 4 implementation must preserve the global principle:

`block the unsafe path + provide the safe path`

## 2. Non-goals and hard exclusions

Phase 4 does **not** provide:

- arbitrary Git command execution;
- arbitrary `gh` command execution;
- `gh api`;
- arbitrary GitHub HTTP endpoints;
- caller-supplied Git argv, executable, config or environment;
- caller-supplied GitHub URL, method, headers or Authorization;
- force push or force-with-lease;
- branch deletion;
- reset as a generic operation;
- amend;
- rebase;
- history rewrite;
- destructive checkout;
- automatic conflict resolution;
- non-fast-forward local merge;
- arbitrary merge strategies;
- permanent PAT storage;
- implicit GitHub account administration from `full-repo-write`;
- source-control authorization derived from shell permission or shell-risk parsing;
- generic `source_control`, `git_execute`, `github_execute`, raw command or raw args tools.

Existing shell tools remain independent capabilities and are not an authorization bypass for source control.

## 3. Exact Phase 4 public tool surface

Phase 4 adds exactly eleven first-class source-control MCP tools.

### 3.1 Local Git tools

1. `git_create_branch`
2. `git_stage_paths`
3. `git_unstage_paths`
4. `git_commit`
5. `git_merge_branch`
6. `git_push_branch`

### 3.2 GitHub tools

7. `github_get_repository`
8. `github_create_repository`
9. `github_get_pull_request`
10. `github_create_pull_request`
11. `github_merge_pull_request`

At Phase 4 opening the complete MCP catalog contains 50 tools and the Edge workspace manifest contains 17 workspace tools after Phase 3. Registering the eleven Phase 4 tools must therefore produce exactly:

- complete MCP catalog: `50 -> 61` tools;
- Edge workspace manifest: `17 -> 28` tools.

These counts are acceptance invariants, not manually maintained version strings. Catalog and descriptor revisions must be derived by the existing repository mechanisms.

## 4. Exact capability model

Phase 4 exposes exactly ten source-control capabilities:

- `git.branch.write`
- `git.index.write`
- `git.commit.write`
- `git.merge.write`
- `git.remote.push`
- `github.repository.read`
- `github.repository.create`
- `github.pull_request.read`
- `github.pull_request.create`
- `github.pull_request.merge`

`git_stage_paths` and `git_unstage_paths` share `git.index.write` because both modify only the index.

`git_merge_branch` uses the separate `git.merge.write` capability. Permission to create a branch does not imply permission to move the current branch by merging another branch.

Capabilities are explicit and additive. `full-repo-write` alone grants none of these capabilities and never grants GitHub account administration.

### 4.1 Workspace policy extension

`WorkspacePolicy` gains an optional additive `sourceControl` section:

- `capabilities`: explicit subset of the ten capabilities;
- `accountOwners`: explicit GitHub owners under which repository creation may be authorized;
- `additionalRepositories`: explicit repository targets allowed in addition to the workspace canonical GitHub repository.

Legacy policies without `sourceControl` remain valid and receive no source-control privileges.

Absence is fail-closed.

### 4.2 Permission interaction

Read operations require the relevant source-control capability and authorized target, but do not depend on shell permission.

Mutating operations require:

1. the exact source-control capability; and
2. a workspace permission profile permitting repository writes (`full-repo-write`).

Repository creation additionally requires the target owner in `accountOwners`.

Repository-scoped GitHub operations require the target repository to be either:

- the canonical GitHub repository resolved from the selected workspace real `origin`; or
- explicitly present in `additionalRepositories`.

If canonical resolution is unavailable, malformed or ambiguous, authorization fails closed unless the target is explicitly allowlisted.

## 5. Protected branch policy

Protected-branch enforcement must be structural and typed. It must not depend on parsing a shell command string.

For Phase 4, `main` is protected from direct local mutation paths that would publish or integrate work outside the approved PR/deployment gate.

The typed boundary must fail closed for:

- direct commit while current branch is `main`;
- local `git_merge_branch` whose target/current branch is `main`;
- `git_push_branch` from or to `main`.

Creating a new feature branch from an expected `main` HEAD is permitted.

`github_merge_pull_request` is a distinct remote integration path. It remains allowed only when its source-control policy, typed confirmation, expected PR head SHA and reconciliation checks all pass. In this repository, merging a PR whose base is `main` is operationally a production deployment gate because Cloudflare Git integration auto-deploys on `main`; Phase 4 must not perform such a merge automatically.

No typed operation may introduce a force/history-rewrite exception to protected-branch policy.

## 6. Strict contracts and executor ports

All eleven operations use strict Zod contracts. Unknown fields fail validation.

Reusable domain primitives include:

- Git SHA: exactly 40 hexadecimal characters, normalized to lowercase;
- Git branch: validated Git branch/ref-safe name, 1–255 characters;
- Git paths: bounded, unique, workspace-relative POSIX-normalized paths;
- GitHub owner/repository slugs;
- GitHub full repository name;
- positive pull-request number;
- repository visibility: `private | public | internal`;
- merge method for GitHub PR merge: `merge | squash`.

Forbidden escape-hatch fields include `command`, `args`, `argv`, `force`, `forceWithLease`, `url`, `headers`, `authorization`, `token`, caller Git config and caller environment.

### 6.1 Git operation matrix

#### `git_create_branch`
Required:
- `workspaceId`
- `branch`
- `expectedHeadSha`

Optional:
- `root`

Result:
- `root`
- `branch`
- `headSha`

Semantics:
- verify current HEAD exactly matches `expectedHeadSha`;
- reject existing/conflicting branch;
- creating a feature branch from protected `main` is permitted;
- no checkout/reset escape hatch is exposed.

#### `git_stage_paths`
Required:
- `workspaceId`
- non-empty unique `paths`

Optional:
- `root`

Result:
- `root`
- `headSha`
- `indexTreeSha`
- normalized `paths`

Semantics:
- stage only the explicit validated paths;
- reject absolute paths, traversal and `.git` internals;
- maximum 200 paths per operation.

#### `git_unstage_paths`
Required:
- `workspaceId`
- non-empty unique `paths`
- `expectedHeadSha`
- `expectedIndexTreeSha`

Optional:
- `root`

Result:
- `root`
- `headSha`
- new `indexTreeSha`
- normalized `paths`

Semantics:
- verify HEAD and index tree before mutation;
- unstage only explicit validated paths;
- implementation must use a fixed index-safe Git argv, equivalent to `git restore --staged -- <paths...>`;
- generic reset is not exposed or accepted.

#### `git_commit`
Required:
- `workspaceId`
- `message`
- `expectedHeadSha`
- `expectedIndexTreeSha`

Optional:
- `root`

Result:
- `root`
- `branch`
- `commitSha`

Semantics:
- current branch must not be protected `main`;
- verify HEAD and index tree before mutation;
- normal commit only;
- no amend/signing/config override surface is exposed.

#### `git_merge_branch`
Required:
- `workspaceId`
- `sourceBranch`
- `expectedTargetHeadSha`
- `expectedSourceHeadSha`

Optional:
- `root`

Result:
- `root`
- `branch`
- `previousHeadSha`
- `headSha`
- `sourceHeadSha`
- `fastForwarded`

Semantics:
- target is the currently checked-out branch;
- current target branch must not be protected `main`;
- verify target HEAD equals `expectedTargetHeadSha`;
- verify source branch resolves exactly to `expectedSourceHeadSha`;
- require clean index/worktree for the merge boundary;
- only fast-forward merge is permitted;
- the mutation is equivalent to a fixed `git merge --ff-only <expectedSourceHeadSha>` after all preconditions;
- conflicts, merge commits, strategy overrides, rebase and automatic resolution are out of scope.

#### `git_push_branch`
Required:
- `workspaceId`
- `branch`
- `expectedLocalSha`

Optional:
- `root`
- `remote`, default `origin`
- `expectedRemoteSha`
- `confirmationId`

Result when confirmation is pending:
- strict typed confirmation-required result

Result when completed:
- `root`
- `remote`
- `branch`
- `localSha`
- `remoteSha`

Semantics:
- protected `main` may not be source or destination;
- verify local branch SHA;
- snapshot remote state;
- verify optional expected remote SHA;
- no force variants;
- ambiguous push outcome is reconciled by re-reading the remote before any retry decision.

### 6.2 GitHub operation matrix

#### `github_get_repository`
Required:
- `workspaceId`
- `owner`
- `repository`

Optional:
- `root`

Result:
- `owner`
- `name`
- `fullName`
- `defaultBranch`
- `visibility`
- `url`

#### `github_create_repository`
Required:
- `workspaceId`
- `owner`
- `name`
- `visibility`

Optional:
- `description`
- `confirmationId`

Result:
- typed confirmation-required result or repository result.

#### `github_get_pull_request`
Required:
- `workspaceId`
- `owner`
- `repository`
- `pullNumber`

Optional:
- `root`

Result:
- `number`
- `state`
- `title`
- `url`
- `headSha`
- `baseSha`
- `merged`

#### `github_create_pull_request`
Required:
- `workspaceId`
- `owner`
- `repository`
- `title`
- `head`
- `base`

Optional:
- `root`
- `body`
- `draft`
- `confirmationId`

Result:
- typed confirmation-required result or pull-request result.

#### `github_merge_pull_request`
Required:
- `workspaceId`
- `owner`
- `repository`
- `pullNumber`
- `expectedPullRequestHeadSha`
- `mergeMethod` (`merge | squash`)

Optional:
- `root`
- `confirmationId`

Result:
- typed confirmation-required result or:
  - `number`
  - `merged`
  - `mergeSha`

Semantics:
- re-read PR before mutation;
- require PR head SHA to equal `expectedPullRequestHeadSha`;
- send expected SHA in the GitHub merge body;
- reconcile ambiguous result by re-reading PR state;
- no automatic production merge is performed by Phase 4 implementation work.

### 6.3 Separate ports

Local Git and GitHub remain separate interfaces:

`GitRepositoryExecutor`
- `createBranch`
- `stagePaths`
- `unstagePaths`
- `commit`
- `mergeBranch`
- `pushBranch`

`GitHubExecutor`
- `getRepository`
- `createRepository`
- `getPullRequest`
- `createPullRequest`
- `mergePullRequest`

A relay-backed implementation may implement both interfaces, but the public types and authorization domains remain separate.

## 7. Typed confirmation

Source-control confirmation is bound to typed operation identity, never to shell text.

Canonical binding:

`workspaceId + operation + targetResource + canonicalArgumentsDigest`

Requirements:

- maximum TTL: 10 minutes;
- opaque confirmation ID;
- one-shot consumption;
- operation/workspace/target/argument mismatch fails;
- mismatch does not consume an otherwise valid grant;
- expiry fails;
- credentials are never part of the digest or binding;
- process-local implementation must remain compatible with a future distributed/ACTIVE->STANDBY authority.

Confirmation policy:

No additional source-control confirmation after policy/precondition checks:
- `git_create_branch`
- `git_stage_paths`
- `git_unstage_paths`
- `git_commit`
- `git_merge_branch` fast-forward-only

Typed confirmation required by default:
- `git_push_branch`
- `github_create_pull_request`

Always typed-confirmed:
- `github_create_repository`
- `github_merge_pull_request`

Read operations require no mutation confirmation.

This confirmation model is separate from `CommandConfirmationRegistry`, whose binding is intentionally shell-command-specific.

## 8. Mutation idempotency and reconciliation

Every source-control mutation participates in a typed mutation receipt model.

State model:

`reserved -> executing -> completed | reconciliation_required`

Canonical mutation identity includes:

- workspace;
- typed operation;
- target resource;
- canonical arguments digest;
- idempotency key.

Rules:

- same idempotency key + same canonical identity may return a completed validated result without backend re-execution;
- same key + changed operation/arguments/target fails with typed idempotency conflict;
- `executing` after interruption is never blindly replayed;
- ambiguous mutations require authoritative state reconciliation;
- completed replay is evaluated before consuming another one-shot confirmation;
- receipts contain only sanitized public identity/result data;
- receipts never persist credentials, Authorization material, raw stderr, raw response bodies or confirmation secrets.

For local Git operations, reconciliation uses repository refs/index/HEAD as authoritative state.

For GitHub operations, reconciliation uses fixed typed GitHub read endpoints.

## 9. Hardened Git mutation boundary

The existing `GitService` remains the inspection-oriented service. It must not simply be promoted into the mutation boundary because its current process runner is designed for inspection and is not sufficient for source-control mutations.

A separate `GitRepositoryService` owns the six typed Git mutations.

Security requirements:

- controlled Git executable resolution;
- `spawn(..., { shell: false })`;
- argv constructed only inside the service from typed inputs;
- no public/general `runGit(args)` escape hatch;
- allowlisted child environment rather than raw ambient credentials/config;
- no inherited `GITHUB_TOKEN`, `GH_TOKEN`, OIDC request tokens or arbitrary Git credential variables;
- no caller-provided Git config/env;
- sanitized errors without raw credential-bearing stderr;
- path/root authorization shares the existing workspace/path-security invariants through a narrow reusable internal primitive rather than duplicated weaker checks;
- state/SHA preconditions before mutation;
- cancellation/deadline terminates child process tree;
- ambiguous mutation outcome reconciled before any retry decision;
- no force/history rewrite.

Internal fixed Git operations may include only the commands needed to implement the typed contracts, such as:

- `rev-parse HEAD`
- `rev-parse --verify <ref>`
- `check-ref-format --branch <branch>`
- branch creation from expected SHA
- explicit-path `add`
- explicit-path `restore --staged`
- `write-tree`
- cached/worktree cleanliness checks
- normal `commit -m <message>`
- `merge --ff-only <expectedSourceSha>`
- `ls-remote --heads`
- `push <remote> <localSha>:refs/heads/<branch>`
- `remote get-url origin`

The caller never supplies these argv templates.

## 10. GitHub credential and HTTP boundary

GitHub API access uses:

- `GitHubCredentialProvider` — opaque in-memory credential source;
- `GhCliUserCredentialProvider` — bootstrap/local provider that may invoke only exactly `gh auth token`;
- `GitHubHttpClient` — fixed GitHub API transport;
- `GitHubService` — exactly five typed GitHub methods.

No `gh api`, `gh repo`, arbitrary `gh` args or shell command string is accepted.

`GitHubHttpClient` fixes:

- base URL `https://api.github.com`;
- application User-Agent;
- `Accept: application/vnd.github+json`;
- `X-GitHub-Api-Version: 2022-11-28`;
- Authorization injection internally.

Allowed endpoint templates are constructed internally for:

- authenticated user lookup;
- repository lookup;
- user/org repository creation;
- PR lookup;
- PR creation;
- PR merge;
- narrowly scoped reconciliation reads required by those mutations.

Caller input cannot choose HTTP method, endpoint, URL or headers.

Credential values must never appear in MCP results, audit, receipts, public exceptions, diagnostic details or generated manifests.

The design remains compatible with replacing `gh auth token` bootstrap by GitHub App installation tokens without changing MCP contracts.

## 11. LocalAgent authorization pipeline

Each source-control operation follows one typed pipeline.

For repository-scoped operations:

1. parse exact input schema;
2. resolve workspace and canonical path/root;
3. resolve typed target;
4. enforce permission profile + exact source-control capability + target authorization;
5. enforce protected-branch rules where applicable;
6. resolve completed receipt replay/conflict;
7. satisfy typed confirmation when required;
8. reserve/advance mutation receipt when mutating;
9. invoke exactly one typed backend operation;
10. parse exact result schema;
11. complete receipt;
12. write sanitized audit metadata.

Capability denial and protected-target denial must happen before backend mutation.

Repository creation authorizes an account owner rather than a canonical repository because the repository does not yet exist.

Canonical GitHub repository resolution reads the selected workspace real `origin` through the hardened Git boundary and accepts only unambiguous GitHub repository forms. Malformed, non-GitHub, query-bearing or ambiguous remotes fail closed unless the requested repository is explicitly in `additionalRepositories`.

## 12. Relay integration

Phase 4 adds exactly eleven internal relay operations:

- `gitCreateBranch`
- `gitStagePaths`
- `gitUnstagePaths`
- `gitCommit`
- `gitMergeBranch`
- `gitPushBranch`
- `githubGetRepository`
- `githubCreateRepository`
- `githubGetPullRequest`
- `githubCreatePullRequest`
- `githubMergePullRequest`

Requirements:

- exact strict request schema per operation;
- exact strict result schema per operation;
- unknown fields fail;
- Gateway method maps to one relay operation;
- Agent dispatcher maps to one LocalAgent method;
- no generic execute operation;
- mutation operations are not included in automatic transport retry policy merely because their backend is reconcilable;
- read-only GitHub operations may participate in the existing bounded retry policy if their operation classification is explicitly read-only/idempotent.

Serializable relay context contains only:

- `correlationId`;
- `invocationId`;
- `idempotencyKey`;
- `ownerScope`.

`AbortSignal` remains local. Deadline remains in the envelope.

Agent hello capabilities must derive from one authoritative relay-operation source, not a divergent manual list.

## 13. Audit and public errors

Audit may contain only sanitized public source-control metadata:

- operation;
- capability;
- target resource;
- expected/result public SHA values where relevant;
- idempotency outcome;
- workspace/correlation/duration/status metadata.

Audit must not contain:

- credentials;
- Authorization headers;
- confirmation secrets;
- raw Git stderr;
- raw GitHub bodies;
- opaque private transport exceptions.

Typed source-control errors must distinguish at least:

- capability/target denial;
- invalid/expired confirmation;
- idempotency conflict;
- reconciliation required;
- HEAD mismatch;
- branch conflict;
- index changed;
- remote changed;
- merge precondition / non-fast-forward rejection.

Existing stable public error-code/message compatibility rules remain in force.

## 14. MCP registration and annotations

Public MCP registration happens only after contracts, policy, services, LocalAgent and relay wiring are GREEN.

Annotations:

| Tool | readOnly | destructive | idempotent |
| --- | --- | --- | --- |
| `git_create_branch` | false | false | false |
| `git_stage_paths` | false | false | true |
| `git_unstage_paths` | false | false | true |
| `git_commit` | false | false | false |
| `git_merge_branch` | false | false | true |
| `git_push_branch` | false | true | true |
| `github_get_repository` | true | false | true |
| `github_create_repository` | false | true | true |
| `github_get_pull_request` | true | false | true |
| `github_create_pull_request` | false | true | true |
| `github_merge_pull_request` | false | true | true |

For MCP annotations, `destructiveHint` denotes externally impactful/high-impact behavior. It does not authorize force/history rewrite.

The MCP authentication/operation-context behavior used by existing tools remains unchanged.

Catalog metadata, contract revision, descriptor revision, tool-set revision and generated Edge manifest must be recalculated using existing canonical generator/identity mechanisms. No hash/version is manually invented.

## 15. TDD and validation requirements

Implementation is TDD-driven.

For every new production behavior where practical:

1. write focused RED;
2. run and capture the expected failure;
3. implement the minimum production change;
4. run GREEN;
5. run affected regression/typecheck before moving on.

Required validation layers:

- all eleven strict contract schemas;
- forbidden escape-hatch fields;
- exact ten-capability model;
- legacy policy compatibility and fail-closed default;
- protected-branch rules;
- typed confirmation binding/expiry/replay/mismatch;
- mutation receipts/idempotency/reconciliation;
- Git process hardening and fixed argv templates;
- stage/unstage path boundaries;
- commit SHA/index preconditions;
- fast-forward-only local merge;
- push remote reconciliation;
- GitHub credential redaction and fixed endpoint mapping;
- LocalAgent denial-before-backend;
- relay strictness/context/hello parity;
- exact public eleven-tool set;
- catalog count 61;
- Edge workspace tool count 28;
- generated manifest parity;
- MCP Core/Gateway/Workspace Agent relevant full suites;
- root typecheck;
- root build;
- Edge dry-run check;
- `diff-check`;
- Gitleaks/secret scan;
- static unsafe-pattern review;
- UTF-8/BOM checks on new source-control files;
- protected operational checkout verification.

Heavy repository-wide checks should use the persistent background-task mechanism once `wait_background_task` is available in the runtime executing the tests.

## 16. Implementation sequencing

The approved Phase 4 sequence is:

1. strict eleven-operation contracts and separate Git/GitHub executor ports;
2. explicit ten-capability source-control policy;
3. typed confirmation and mutation receipts;
4. hardened six-operation `GitRepositoryService`;
5. GitHub credential provider, fixed HTTP client and five-operation `GitHubService`;
6. LocalAgent + audit + strict relay integration;
7. exact eleven-tool MCP registration + catalog/Edge manifest update;
8. final source-control boundary invariants and transversal security/regression gates.

Each step may be committed locally after its own RED/GREEN/review gates. No Phase 4 commit is pushed while Phases 4–7 remain in progress.

## 17. Acceptance criteria

Phase 4 is complete only when all of the following are true:

- exactly eleven typed source-control tools exist and no generic source-control escape hatch exists;
- exactly ten source-control capabilities exist;
- stage and unstage operate only on explicit validated paths;
- local merge is fast-forward-only and refuses protected `main`;
- direct commit/push of protected `main` is blocked structurally;
- Git mutations execute through the hardened typed Git service, not arbitrary shell;
- GitHub operations execute through fixed typed endpoints, not arbitrary `gh` or HTTP;
- source-control confirmation is typed and independent of shell strings;
- mutations are idempotent/reconcilable and ambiguous mutations are never blindly replayed;
- credentials and raw sensitive diagnostics are absent from model-visible results, audit and receipts;
- relay operations are strict and one-to-one;
- complete MCP catalog has exactly 61 tools;
- Edge workspace manifest has exactly 28 tools;
- generated catalog/manifest parity is GREEN;
- all focused and broader regression/security gates are fresh and GREEN;
- the original operational checkout remains unchanged outside the permitted local `.codex` state;
- the cumulative branch remains local-only beyond the Phase 1 remote snapshot until the final integration gate;
- no PR/merge/deploy/restart/cutover occurs as part of Phase 4 implementation without a separate explicit gate.
