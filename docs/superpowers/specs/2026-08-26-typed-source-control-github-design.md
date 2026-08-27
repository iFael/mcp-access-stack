# Typed Git/GitHub Source-Control for MCP GPT V3 — Design

Status: RECONSTITUTED DRAFT FOR RE-APPROVAL

## Provenance

This document reconstitutes the architecture approved on 2026-08-26 after the temporary Git boundary that held the original file was lost. It is intentionally **not** presented as byte-identical to the historical document.

Historical canonical path: `docs/superpowers/specs/2026-08-26-typed-source-control-github-design.md`.

Historical SHA-256: `7b4e07927b5f8567e248e1b240ebaf514a96cd3e8ea39155bb6be18c923f79d7`.

Reconstruction base: `4d5747957d5512ef61827761efe00b045188502b` on branch `recovery/typed-source-control` in the durable recovery boundary. The separately preserved `e73316b1e53ab52cdc4907ab1dfbe26530fc3af2` is not an ancestor of this base and is not incorporated.

The durable decisions below come from preserved handoffs, validation records, exact tool/capability names, prior implementation evidence, and the code structure at the historical base. Where the exact historical source shape was not recoverable, this document states the semantic requirement instead of claiming byte-for-byte recovery.

## 1. Objective

Add an official, typed, least-privilege Git/GitHub source-control surface to MCP GPT V3 so ChatGPT can perform common repository operations without falling back to arbitrary shell execution or an unrestricted GitHub command surface.

The design must support the final runtime architecture as well as the current LocalAgent/relay architecture:

`ChatGPT -> typed MCP tools -> MCP Core -> Gateway/Relay -> Workspace Agent -> typed Git/GitHub services`

Git local repository mutation and GitHub remote/API mutation remain separate trust domains.

## 2. Non-goals

V1 does **not** provide:

- arbitrary Git command execution;
- arbitrary `gh` command execution or `gh api`;
- arbitrary GitHub HTTP endpoints;
- force push or force-with-lease;
- branch deletion;
- reset, amend, rebase, history rewrite, or destructive checkout;
- arbitrary caller-supplied Git argv/config/env;
- permanent PAT storage;
- implicit GitHub account administration from `full-repo-write`;
- automatic public registration of relay operations before the dedicated MCP-tool registration task.

Existing shell tools remain separate capabilities and must not become the authorization mechanism for source control.

## 3. V1 public tool surface

Exactly nine first-class MCP tools are approved:

| Domain | Tool | Effect |
| --- | --- | --- |
| Git | `git_create_branch` | create a local branch with preconditions |
| Git | `git_stage_paths` | stage an explicit bounded set of paths |
| Git | `git_commit` | create a normal commit with preconditions |
| Git | `git_push_branch` | push one branch without force/history rewrite |
| GitHub | `github_get_repository` | read repository metadata |
| GitHub | `github_create_repository` | create a repository under an authorized account owner |
| GitHub | `github_get_pull_request` | read one pull request |
| GitHub | `github_create_pull_request` | create one pull request |
| GitHub | `github_merge_pull_request` | merge one pull request only against the expected head SHA |

No generic `source_control`, `git_execute`, `github_execute`, raw command, or raw args tool is part of V1.

## 4. Exact capability model

The approved V1 capabilities are exactly:

- `git.branch.write`
- `git.index.write`
- `git.commit.write`
- `git.remote.push`
- `github.repository.read`
- `github.repository.create`
- `github.pull_request.read`
- `github.pull_request.create`
- `github.pull_request.merge`

Capabilities are explicit and additive. `full-repo-write` by itself does not grant any of the nine capabilities and never grants GitHub account administration.

### 4.1 Policy extension

`WorkspacePolicy` gains an optional additive `sourceControl` section. Legacy policies without it remain valid and gain no source-control privileges.

The semantic fields are:

- `capabilities`: explicit subset of the nine capability names;
- `accountOwners`: explicit GitHub account owners under which repository creation may be authorized;
- `additionalRepositories`: explicit repository targets allowed in addition to the workspace's canonical GitHub repository.

Absence of a field is fail-closed. Empty capability/owner/repository sets grant nothing.

Source-control authorization must not be mapped to `allowShell` or shell command classification.

### 4.2 Permission interaction

Read operations require the relevant source-control capability and target authorization. They do not depend on shell permission.

Mutating operations require both:

1. the exact source-control capability; and
2. a workspace permission profile that permits repository writes (`full-repo-write`).

Repository creation additionally requires the target account owner to be present in `accountOwners`.

Repository-scoped GitHub operations additionally require the target repository to be either:

- the canonical GitHub repository resolved from the selected workspace's real `origin`; or
- explicitly present in `additionalRepositories`.

If canonical repository resolution is unavailable or ambiguous, authorization fails closed unless the target is explicitly listed as an additional repository.

## 5. Contracts and ports

All nine operations use strict Zod contracts. Unknown fields are rejected. Contracts validate domain primitives such as Git SHA, repository owner/name/full-name, branch/ref values, pull-request numbers, and staging paths.

Escape-hatch fields such as `force`, raw command strings, raw argv, raw Git config, arbitrary headers, or arbitrary endpoint paths are forbidden.

Known recovered precondition requirements include:

- `git_push_branch` carries `expectedLocalSha` and may carry `expectedRemoteSha`; the remote defaults to `origin`; force variants are not accepted;
- `github_merge_pull_request` carries `expectedPullRequestHeadSha`; a divergent PR head fails closed.

The remaining input/result shapes must be reconstructed as strict typed contracts during the implementation plan; they must preserve the semantic boundaries in this document rather than inventing a generic execution surface.

Two executor ports remain separate:

- `GitRepositoryExecutor` for local Git repository operations;
- `GitHubExecutor` for GitHub API operations.

They may be implemented by in-process LocalAgent, relay-backed Gateway executors, or subprocess/future runtime adapters, but the domains remain distinct.

## 6. Typed confirmation

Source-control confirmation is bound to a canonical operation identity, never to a shell string.

The binding is exactly:

`workspaceId + operation + canonicalArgumentsDigest + targetResource`

Canonical 	argetResource values are typed identities such as github:repository/owner/repo, github:pull-request/owner/repo#123, or a Git branch identity scoped to the selected repository root. They are not shell command strings.

Rules:

- maximum initial TTL: 10 minutes;
- one-shot consumption;
- argument or target mismatch does not grant the changed operation;
- mismatch does not consume an otherwise valid grant;
- replay after consumption fails;
- expiry fails;
- the model must be compatible with an `ACTIVE -> STANDBY` handoff rather than relying on process-local command text.

Confirmation policy for V1:

- `git_create_branch`, `git_stage_paths`, and `git_commit`: no additional source-control confirmation when policy already authorizes them;
- `git_push_branch`: typed confirmation required by default; the reconstructed V1 implementation keeps that default enabled;
- `github_create_pull_request`: typed confirmation required by default; the reconstructed V1 implementation keeps that default enabled;
- `github_create_repository`: always typed-confirmed;
- `github_merge_pull_request`: always typed-confirmed;
- read operations: no mutation confirmation.

Repository creation and PR merge are non-relaxable high-impact operations in V1.

## 7. Mutation idempotency and reconciliation

Mutations use `OperationContext.idempotencyKey` and a `MutationReceiptStore`. The approved state model is:

`reserved -> executing -> completed | reconciliation_required`

Rules:

- same idempotency key + same canonical operation identity may return the completed, validated result without re-running the backend;
- same key + different operation/arguments/target fails closed with an idempotency conflict;
- `executing` after interruption is not blindly retried;
- ambiguous or interrupted mutations move to or are treated as `reconciliation_required`;
- reconciliation queries the authoritative local/remote state before any retry decision;
- completed replay is checked before re-consuming a one-shot confirmation;
- receipts never persist credentials or Authorization material.

The distributed runtime's Durable Object remains the eventual authority for handoff/distributed coordination. A local file/in-memory receipt store is an implementation seam, not a distributed lock.

## 8. GitRepositoryService

`GitRepositoryService` owns the four local Git mutations.

Security requirements:

- resolve an absolute Git executable only from acceptable absolute PATH entries;
- spawn Git with `shell:false`;
- construct argv internally from typed inputs;
- use an allowlisted child environment rather than raw `process.env`;
- do not inherit OIDC tokens, GitHub tokens, arbitrary Git config redirection, or caller-provided credential environment;
- do not expose raw stderr when it can contain sensitive path/credential data;
- enforce branch/ref/path validation before invocation;
- use SHA/state preconditions to detect stale caller state;
- reconcile ambiguous mutation outcomes instead of blind retry;
- never implement force/history rewrite in V1.

Authenticated Git-over-HTTPS push credential injection is a later controlled wiring concern. It must not be implemented by inheriting ambient credentials or accepting arbitrary caller Git options.

## 9. GitHub credential and HTTP boundary

GitHub API access is implemented through:

- `GitHubCredentialProvider` — returns an opaque credential kept in memory;
- `GhCliUserCredentialProvider` — local/bootstrap provider that may invoke only `gh auth token`, never `gh api`;
- `GitHubHttpClient` — fixed GitHub API transport;
- `GitHubService` — typed repository/PR operations.

Definitive runtime authentication uses GitHub App installation tokens for repository-scoped actions and a separate provider/authorization path for account-level repository provisioning. Permanent PATs are not part of the design.

HTTP requirements:

- base API fixed to `https://api.github.com`;
- endpoint templates constructed internally;
- fixed GitHub API version;
- Authorization injected internally;
- no arbitrary URL/path/header from the model;
- credential value never appears in MCP results, audit records, receipts, or public exceptions.

Diagnostics must be sanitized. Raw `gh` stderr, raw `fetch` errors, raw transport details, raw response bodies, and raw JSON parse diagnostics must not survive in public `AppError.cause` or audit metadata.

Repository creation, PR creation, and merge use reconciliation instead of blind retry when the mutation result is ambiguous. Merge closes the PR-head TOCTOU by sending the expected head SHA with the merge request.

## 10. LocalAgent authorization pipeline

The LocalAgent integrates policy, target resolution, confirmation, receipts, typed services, validation, and audit.

For repository-scoped GitHub operations:

1. validate the typed input;
2. resolve the workspace/policy;
3. determine the target repository;
4. authorize the exact capability and repository target;
5. check for a completed idempotent replay/conflict;
6. satisfy typed confirmation when required;
7. reserve/advance the mutation receipt;
8. invoke exactly one typed backend operation;
9. validate the typed result;
10. complete the receipt;
11. write sanitized audit metadata.

Repository creation authorizes an account owner rather than a canonical repository because the target repository does not exist yet.

Canonical GitHub repository resolution reads the workspace Git `origin` through the hardened Git boundary and accepts only unambiguous GitHub repository forms. Non-GitHub, malformed, query-bearing, or structurally ambiguous remotes fail closed for canonical authorization.

Capability denial must occur before the backend is invoked.

## 11. Relay integration

Task 6 adds exactly these internal relay operations:

- `gitCreateBranch`
- `gitStagePaths`
- `gitCommit`
- `gitPushBranch`
- `githubGetRepository`
- `githubCreateRepository`
- `githubGetPullRequest`
- `githubCreatePullRequest`
- `githubMergePullRequest`

`relayOperationSchema`, the discriminated `relayRequestSchema`, and `relayResultSchemas` are the internal protocol authorities.

Requirements:

- every source-control request uses the exact strict input schema;
- every result is parsed with the exact public result schema;
- unknown request/result fields fail protocol validation;
- Gateway `RelayWorkspaceExecutor` maps each typed method to one and only one relay operation;
- Agent dispatcher maps each relay operation to one and only one LocalAgent typed method;
- no generic relay execute operation is introduced.

The serializable operation context carried across the relay preserves:

- `correlationId`;
- `invocationId`;
- `idempotencyKey`;
- `ownerScope`.

`AbortSignal` remains local and is never serialized. Deadline remains in the existing protocol deadline field.

Agent hello capabilities must be derived from `relayOperationSchema.options` (or an equivalently single authoritative source), not maintained as a divergent manual list.

These relay operations remain internal through Task 6. They must not be added to `WorkspaceToolName`, `WORKSPACE_TOOL_NAMES`, `relayOperationToToolName`, or the public MCP catalog until Task 7.

## 12. Audit and errors

Audit may record only public/sanitized source-control metadata needed for accountability:

- operation;
- source-control capability;
- `targetResource`;
- expected/result public SHA values when relevant;
- idempotency outcome such as `executed`, `completed_replay`, or `confirmation_required`;
- normal workspace/correlation/duration/status fields.

Audit must not contain credential values, Authorization headers, confirmation secrets, raw Git/GitHub diagnostics, or opaque private response bodies.

Known fail-closed source-control codes include `SOURCE_CONTROL_CAPABILITY_DENIED`, `SOURCE_CONTROL_CONFIRMATION_INVALID`, `SOURCE_CONTROL_IDEMPOTENCY_CONFLICT`, and `SOURCE_CONTROL_RECONCILIATION_REQUIRED`. Error text must remain stable/sanitized and must not become a transport for secrets.

## 13. Public MCP registration

Public exposure is a separate task after relay/LocalAgent integration is complete.

Task 7 registers exactly the nine approved first-class tool names with:

- strict input/output schemas;
- correct read-only/destructive/idempotent annotations;
- existing MCP authentication handling;
- `OperationContext` creation/propagation;
- one typed executor method per tool;
- recalculated tool-set/catalog contract metadata.

No extra Git/GitHub tools are added as part of V1 registration.

## 14. TDD and validation requirements

Implementation is TDD-driven. A production behavior must not be added before a focused test has demonstrated the missing behavior where practical.

Required validation layers include:

- contract parsing/rejection tests;
- policy/capability tests, including legacy compatibility and owner/repository denial;
- typed confirmation binding/expiry/replay tests;
- mutation receipt replay/conflict/reconciliation tests;
- Git process/ref/service tests;
- GitHub credential/provider/service tests with redaction assertions;
- LocalAgent integration tests proving denial-before-backend and confirmation/idempotency behavior;
- relay request/result/schema and one-to-one routing tests;
- Agent hello/context transport tests;
- public MCP catalog/registration tests in the registration task;
- fresh typecheck/build for affected packages;
- `git diff --check`;
- UTF-8/BOM checks where applicable;
- unsafe-pattern review;
- secret scan/Gitleaks over the reconstructed delta.

Historical PASS results from the lost scratch are evidence of the previous implementation only. Every reconstructed task must receive fresh validation.

## 15. Implementation sequencing boundary

The recovered sequence is:

1. strict source-control contracts and `GitRepositoryExecutor` / `GitHubExecutor` ports;
2. explicit source-control capability policy;
3. typed confirmation and mutation receipts/reconciliation;
4. hardened `GitRepositoryService`;
5. GitHub credential provider / HTTP client / `GitHubService`;
6. LocalAgent + audit + relay integration;
7. first-class MCP tool registration and catalog update;
8. final integration/hardening gate to be specified in the reconstituted implementation plan from repository evidence, rather than invented from incomplete historical text.

The exact historical Task 8 text was not recoverable. The reconstituted plan must define it explicitly and must not silently pretend it was recovered verbatim.

## 16. Acceptance criteria

The design is accepted when all of the following are true:

- source control can be used through typed operations without arbitrary shell/GitHub escape hatches;
- authorization is explicit per capability and per target;
- GitHub account provisioning is not implied by workspace write access;
- high-impact mutations are bound to typed confirmation identity;
- mutations are idempotent/reconcilable and never blindly replayed after ambiguity;
- local Git and GitHub API credentials are isolated from model-visible inputs/results/audit;
- relay protocol remains strict and one-to-one;
- public MCP exposure is exactly the approved nine-tool surface;
- the implementation remains compatible with the future GitHub Actions/Durable Object runtime without depending on Windows-specific credential persistence;
- every reconstructed implementation task has fresh TDD and verification evidence.