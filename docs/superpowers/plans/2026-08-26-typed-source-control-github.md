# Typed Git/GitHub Source-Control Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 4 typed source-control boundary with exactly eleven MCP tools and ten capabilities, covering six local Git operations and five GitHub operations without arbitrary shell, Git argv, `gh api`, force/history rewrite or caller-controlled HTTP escape hatches.

**Architecture:** Keep local Git and GitHub API operations behind separate `GitRepositoryExecutor` and `GitHubExecutor` ports. MCP tools call those typed ports; Gateway maps them one-to-one onto strict relay operations; LocalAgent performs policy, protected-branch, typed-confirmation, idempotency/reconciliation and audit checks before invoking hardened Git/GitHub services. The existing `GitService` remains inspection-oriented; mutable Git operations use a separate hardened `GitRepositoryService`.

**Tech Stack:** TypeScript, Node.js, Zod, Jest, MCP SDK, Git CLI via `spawn(..., { shell: false })`, GitHub REST API via `fetch`, PowerShell only for repository orchestration/validation.

**Spec:** `docs/superpowers/specs/2026-08-26-typed-source-control-github-design.md`

## Current boundary and baseline

- Workspace: `mcp-access-stack`.
- Project root: `runtime/source-worktrees/daily-operational-hardening-phase1/mcp-access-stack`.
- Branch: `feat/daily-operational-hardening-phase1`.
- Phase 3 local HEAD at Phase 4 opening: `950c504fc421cc756636d12f89dd57ae118bcd59`.
- Remote branch remains at Phase 1: `2704b473a89fed349921201238730f4a04145478`.
- Origin/main baseline remains `59d00ba76584a23e582844f36b8acaecb5980a1c`.
- Original operational checkout remains protected on `feat/minimal-windows-execution-node` with its 19 pre-existing modified `.ps1` files and empty staging.
- No push, PR, merge, deploy, restart or cutover is part of Phase 4 implementation.

## Global constraints

- Use exclusively MCP GPT - OFICIAL V3 for repository/runtime work.
- TDD is mandatory for new production behavior: focused RED -> minimal GREEN -> affected regression.
- Keep exactly eleven public source-control MCP tools and exactly ten source-control capabilities.
- Keep local Git and GitHub as separate trust domains and executor ports.
- No generic `source_control`, `git_execute`, `github_execute`, raw Git argv, arbitrary `gh`, arbitrary GitHub URL/method/header or caller-provided credentials.
- No force push, force-with-lease, reset as a public operation, amend, rebase, history rewrite, branch deletion, destructive checkout, non-fast-forward local merge or automatic conflict resolution.
- `main` is structurally protected from direct typed commit, local merge and push. Creating a feature branch from an expected `main` HEAD is allowed.
- `github_merge_pull_request` is a distinct typed remote integration operation; no production merge is executed during Phase 4 implementation.
- Mutating relay operations are never added to automatic transport retry merely because their backend can reconcile.
- Credentials, Authorization, raw Git stderr, raw GitHub bodies and confirmation secrets must never appear in MCP results, audit records, receipts, generated manifests or public errors.
- Catalog identity and Edge manifest are generated/recalculated through existing canonical repository mechanisms; never hand-invent revision hashes.
- `.codex` remains local operational state and is never committed.
- Each Task may receive its own local commit after GREEN/review gates; no Phase 4 commit is pushed while Phases 4–7 remain in progress.

## Exact Phase 4 surface

Public tools:

```ts
export const SOURCE_CONTROL_TOOL_NAMES = [
  "git_create_branch",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_merge_branch",
  "git_push_branch",
  "github_get_repository",
  "github_create_repository",
  "github_get_pull_request",
  "github_create_pull_request",
  "github_merge_pull_request",
] as const;
```

Capabilities:

```ts
export const sourceControlCapabilities = [
  "git.branch.write",
  "git.index.write",
  "git.commit.write",
  "git.merge.write",
  "git.remote.push",
  "github.repository.read",
  "github.repository.create",
  "github.pull_request.read",
  "github.pull_request.create",
  "github.pull_request.merge",
] as const;
```

Catalog acceptance after Task 7:
- full MCP catalog: exactly 61 tools;
- Edge workspace manifest: exactly 28 tools.

---

### Task 1: Strict eleven-operation contracts and separate executor ports

**Files:**
- Create: `packages/mcp-core/src/source-control-contracts.ts`
- Create: `packages/mcp-core/src/source-control-executor.ts`
- Modify: `packages/mcp-core/src/errors.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Create: `packages/mcp-core/test/source-control-contracts.test.ts`
- Create: `packages/mcp-core/test/source-control-executor.test.ts`

**Interfaces:**
- Consumes: existing `OperationContext` from `packages/mcp-core/src/contracts.ts`.
- Produces: all eleven strict input/result schemas/types; `GitRepositoryExecutor`; `GitHubExecutor`; source-control operation-name enums; reusable Git/GitHub domain primitives.

Required executor signatures:

```ts
export interface GitRepositoryExecutor {
  createBranch(input: GitCreateBranchInput, context?: OperationContext): Promise<GitCreateBranchResult>;
  stagePaths(input: GitStagePathsInput, context?: OperationContext): Promise<GitStagePathsResult>;
  unstagePaths(input: GitUnstagePathsInput, context?: OperationContext): Promise<GitUnstagePathsResult>;
  commit(input: GitCommitInput, context?: OperationContext): Promise<GitCommitResult>;
  mergeBranch(input: GitMergeBranchInput, context?: OperationContext): Promise<GitMergeBranchResult>;
  pushBranch(input: GitPushBranchInput, context?: OperationContext): Promise<GitPushBranchResult>;
}

export interface GitHubExecutor {
  getRepository(input: GitHubGetRepositoryInput, context?: OperationContext): Promise<GitHubRepositoryResult>;
  createRepository(input: GitHubCreateRepositoryInput, context?: OperationContext): Promise<GitHubCreateRepositoryResult>;
  getPullRequest(input: GitHubGetPullRequestInput, context?: OperationContext): Promise<GitHubPullRequestResult>;
  createPullRequest(input: GitHubCreatePullRequestInput, context?: OperationContext): Promise<GitHubCreatePullRequestResult>;
  mergePullRequest(input: GitHubMergePullRequestInput, context?: OperationContext): Promise<GitHubMergePullRequestResult>;
}
```

Confirmable operations are exactly:

```ts
export const confirmableSourceControlOperationNameSchema = z.enum([
  "git_push_branch",
  "github_create_repository",
  "github_create_pull_request",
  "github_merge_pull_request",
]);
```

Required confirmation result:

```ts
export const sourceControlConfirmationRequiredSchema = z.object({
  status: z.literal("confirmation_required"),
  confirmationId: z.string().min(1).max(128),
  expiresAt: z.string().datetime(),
  operation: confirmableSourceControlOperationNameSchema,
  targetResource: z.string().min(1).max(512),
}).strict();
```

Required error codes added to `AppErrorCode`:

```ts
"SOURCE_CONTROL_CAPABILITY_DENIED"
"SOURCE_CONTROL_CONFIRMATION_INVALID"
"SOURCE_CONTROL_IDEMPOTENCY_CONFLICT"
"SOURCE_CONTROL_RECONCILIATION_REQUIRED"
"GIT_HEAD_MISMATCH"
"GIT_BRANCH_CONFLICT"
"GIT_INDEX_CHANGED"
"GIT_REMOTE_CHANGED"
"GIT_MERGE_NOT_FAST_FORWARD"
"GIT_PROTECTED_BRANCH"
```

- [ ] **Step 1: Write RED contract tests for exact domain primitives and escape-hatch rejection**

Create `source-control-contracts.test.ts` and assert:

```ts
expect(gitShaSchema.parse("A".repeat(40))).toBe("a".repeat(40));
expect(() => gitBranchSchema.parse("../main")).toThrow();
expect(() => gitStagePathsInputSchema.parse({
  workspaceId: "repo",
  paths: ["src/a.ts", "src/a.ts"],
})).toThrow();
expect(() => gitStagePathsInputSchema.parse({
  workspaceId: "repo",
  paths: [".git/config"],
})).toThrow();
expect(() => gitPushBranchInputSchema.parse({
  workspaceId: "repo",
  branch: "feature/x",
  expectedLocalSha: "a".repeat(40),
  force: true,
})).toThrow();
expect(() => githubGetRepositoryInputSchema.parse({
  workspaceId: "repo",
  owner: "acme",
  repository: "app",
  url: "https://example.invalid/api",
})).toThrow();
```

Also assert all eleven schemas are `.strict()` by adding one unknown field to each valid fixture and expecting rejection.

- [ ] **Step 2: Write RED tests for the two new local operations**

```ts
expect(gitUnstagePathsInputSchema.parse({
  workspaceId: "repo",
  paths: ["src/a.ts"],
  expectedHeadSha: "a".repeat(40),
  expectedIndexTreeSha: "b".repeat(40),
})).toEqual({
  workspaceId: "repo",
  paths: ["src/a.ts"],
  expectedHeadSha: "a".repeat(40),
  expectedIndexTreeSha: "b".repeat(40),
});

expect(gitMergeBranchInputSchema.parse({
  workspaceId: "repo",
  sourceBranch: "feature/x",
  expectedTargetHeadSha: "a".repeat(40),
  expectedSourceHeadSha: "b".repeat(40),
})).toMatchObject({ sourceBranch: "feature/x" });
```

Assert `gitMergeBranchInputSchema` rejects `strategy`, `noFf`, `squash`, `rebase`, `force` and a caller-supplied target branch field.

- [ ] **Step 3: Write RED executor-port compile tests**

Create minimal compile-time/runtime structural fixtures in `source-control-executor.test.ts` that instantiate objects satisfying all six Git methods and five GitHub methods, then assert method names are exactly those eleven logical operations.

- [ ] **Step 4: Run RED**

Run:

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts
```

Expected: FAIL because the new modules/exports do not exist.

- [ ] **Step 5: Implement minimal contracts and ports**

Implement the exact matrix from the approved spec, including:
- `gitCreateBranchInputSchema` / `gitCreateBranchResultSchema`;
- `gitStagePathsInputSchema` / `gitStagePathsResultSchema`;
- `gitUnstagePathsInputSchema` / `gitUnstagePathsResultSchema`;
- `gitCommitInputSchema` / `gitCommitResultSchema`;
- `gitMergeBranchInputSchema` / `gitMergeBranchResultSchema`;
- `gitPushBranchInputSchema` / completed/confirmation union result;
- `githubGetRepositoryInputSchema` / `githubRepositoryResultSchema`;
- `githubCreateRepositoryInputSchema` / `githubCreateRepositoryResultSchema` (confirmation-required or completed repository union);
- `githubGetPullRequestInputSchema` / `githubPullRequestResultSchema`;
- `githubCreatePullRequestInputSchema` / `githubCreatePullRequestResultSchema` (confirmation-required or completed PR union);
- `githubMergePullRequestInputSchema` / `githubMergePullRequestResultSchema` (confirmation-required or completed merge union);
- `gitPushBranchResultSchema` as the strict confirmation-required/completed push union;
- `sourceControlOperationNameSchema` with exactly eleven names;
- `confirmableSourceControlOperationNameSchema` with exactly four names;
- reusable `gitShaSchema`, `gitBranchSchema`, `gitPathSchema`, `githubOwnerSchema`, `githubRepositoryNameSchema`, `githubRepositoryFullNameSchema`.

Git path normalization must reject absolute paths, `..`, `.git` and duplicates; max array size = 200.

- [ ] **Step 6: Run GREEN + core typecheck**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
```

Expected: both exit 0.

- [ ] **Step 7: Review Task 1 boundary and create local commit**

Run `git diff --check`, source-control path secret scan and static search for forbidden public input keys. Stage only Task 1 files and commit locally:

```text
feat(mcp): add typed source control contracts
```

No push.

---

### Task 2: Explicit ten-capability policy and protected-target authorization

**Files:**
- Create: `packages/mcp-core/src/source-control-policy.ts`
- Modify: `packages/mcp-core/src/policy.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Modify: `config/workspace-policy.example.json`
- Create: `packages/mcp-core/test/source-control-policy.test.ts`
- Modify: `packages/mcp-core/test/loopback-policy.test.ts`
- Modify: `packages/mcp-core/test/policy-merge.test.ts` only for regression coverage.

**Interfaces:**
- Consumes: `SourceControlCapability`, GitHub full-name primitives from Task 1 and existing `WorkspacePolicy`.
- Produces: `sourceControlPolicySchema`, `WorkspacePolicy.sourceControl`, `assertSourceControlCapability()`, protected-branch helper(s) used by LocalAgent/GitRepositoryService.

Required schema:

```ts
export const sourceControlPolicySchema = z.object({
  capabilities: z.array(sourceControlCapabilitySchema).default([]),
  accountOwners: z.array(githubOwnerSchema).default([]),
  additionalRepositories: z.array(githubRepositoryFullNameSchema).default([]),
}).strict();
```

Required capability assertion shape:

```ts
export function assertSourceControlCapability(input: {
  policy: Pick<WorkspacePolicy, "permissionProfile" | "sourceControl">;
  capability: SourceControlCapability;
  repository?: string;
  canonicalRepository?: string;
  accountOwner?: string;
  mutation: boolean;
}): void;
```

- [ ] **Step 1: Write RED policy tests**

Assert:
- legacy policy with no `sourceControl` parses and grants none;
- exact capability is required;
- `full-repo-write` alone grants none;
- mutation requires `full-repo-write` plus exact capability;
- `git_stage_paths` and `git_unstage_paths` both map to `git.index.write`;
- `git_merge_branch` requires `git.merge.write` and not `git.branch.write`;
- canonical repository is authorized only when exact target matches;
- `additionalRepositories` authorizes explicit non-canonical target;
- repository creation owner must be in `accountOwners`.

- [ ] **Step 2: Write RED protected-branch tests**

Test a typed helper with explicit state rather than shell strings:

```ts
expect(() => assertTypedGitBranchMutationAllowed({
  operation: "git_commit",
  currentBranch: "main",
})).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));

expect(() => assertTypedGitBranchMutationAllowed({
  operation: "git_merge_branch",
  currentBranch: "main",
})).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));

expect(() => assertTypedGitBranchMutationAllowed({
  operation: "git_push_branch",
  currentBranch: "feature/x",
  branch: "main",
})).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));
```

Also assert branch creation from current `main` is not rejected solely because the source branch is protected.

- [ ] **Step 3: Run RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/loopback-policy.test.ts packages/mcp-core/test/policy-merge.test.ts
```

Expected: new policy/protected-branch tests fail before production support.

- [ ] **Step 4: Implement additive fail-closed policy**

Add optional `sourceControl` to `workspacePolicySchema`. Preserve legacy behavior when omitted. Export the ten-capability enum/list and typed protected-branch helper. Do not tie authorization to `allowShell` or `confirmationMode`.

Update `config/workspace-policy.example.json` with a non-secret example containing explicit arrays and all ten capability names.

- [ ] **Step 5: Run GREEN + core regression/typecheck**

Run the Task 2 focused command plus:

```powershell
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
```

Expected: exit 0.

- [ ] **Step 6: Review and local commit**

Run diff-check/secret-scan; verify no legacy workspace receives implicit source-control privileges. Commit locally:

```text
feat(policy): add typed source control capabilities
```

No push.

---

### Task 3: Typed confirmation and mutation receipts

**Files:**
- Create: `packages/mcp-core/src/typed-confirmation.ts`
- Create: `packages/mcp-core/src/mutation-receipts.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Create: `services/workspace-agent/src/source-control/file-mutation-receipt-store.ts`
- Create: `packages/mcp-core/test/typed-confirmation.test.ts`
- Create: `packages/mcp-core/test/mutation-receipts.test.ts`
- Create: `services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts`

**Interfaces:**
- Consumes: Task 1 operation names and `OperationContext.idempotencyKey`.
- Produces: canonical argument digest, `TypedConfirmationRegistry`, `MutationReceiptStore`, in-memory implementation and persistent file implementation.

Canonical confirmation binding:

```ts
export interface TypedConfirmationBinding {
  workspaceId: string;
  operation: ConfirmableSourceControlOperationName;
  targetResource: string;
  canonicalArgumentsDigest: string;
}
```

Receipt identity/state:

```ts
export interface MutationReceiptIdentity {
  workspaceId: string;
  operation: SourceControlOperationName;
  targetResource: string;
  canonicalArgumentsDigest: string;
  idempotencyKey: string;
}

export type MutationReceiptState =
  | "reserved"
  | "executing"
  | "completed"
  | "reconciliation_required";
```

- [ ] **Step 1: Write RED typed-confirmation tests**

Prove TTL <= 10 minutes, opaque ids, one-shot consume, expiry, exact workspace/operation/target/digest binding and that mismatched consumption does not invalidate the original matching grant.

- [ ] **Step 2: Write RED canonical-digest tests**

Prove object-key-order independence and semantic difference sensitivity:

```ts
expect(canonicalSourceControlArgumentsDigest({ a: 1, b: 2 }))
  .toBe(canonicalSourceControlArgumentsDigest({ b: 2, a: 1 }));
expect(canonicalSourceControlArgumentsDigest({ a: 1 }))
  .not.toBe(canonicalSourceControlArgumentsDigest({ a: 2 }));
```

- [ ] **Step 3: Write RED mutation-receipt tests**

Prove:
- reserve -> executing -> completed;
- completed same-identity replay returns stored validated result without backend intent;
- same idempotency key + changed identity throws `SOURCE_CONTROL_IDEMPOTENCY_CONFLICT`;
- `executing` cannot be blindly retried;
- `reconciliation_required` remains explicit;
- receipts reject credential-like fields from persisted public result projections.

- [ ] **Step 4: Write RED persistent file-store tests**

Prove atomic temp-write/rename, reload persistence, per-idempotency-key serialization and storage under `.runtime-private/source-control-receipts` or the existing runtime-private convention resolved by the service. Verify the store does not write confirmation IDs or credentials.

- [ ] **Step 5: Run RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/typed-confirmation.test.ts packages/mcp-core/test/mutation-receipts.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts
```

Expected: FAIL before modules exist.

- [ ] **Step 6: Implement minimal confirmation/receipt state machines**

Implement only typed APIs needed by Phase 4. `TypedConfirmationRegistry` must not reuse `CommandConfirmationRegistry`; shell-command text must not enter its binding. `MutationReceiptStore` must persist only validated public result data and canonical identity metadata.

- [ ] **Step 7: Run GREEN + affected typechecks**

Run Step 5 commands plus:

```powershell
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```

- [ ] **Step 8: Review and local commit**

Secret scan all Task 3 paths; search for `token`, `authorization`, `confirmationId` inside persisted receipt serialization and verify only schema/type names are present where appropriate, not persisted values. Commit locally:

```text
feat(source-control): add confirmation and mutation receipts
```

No push.

---

### Task 4: Hardened six-operation GitRepositoryService

**Files:**
- Create: `services/workspace-agent/src/source-control/git-process-runner.ts`
- Create: `services/workspace-agent/src/source-control/git-repository-service.ts`
- Modify: `services/workspace-agent/src/git/service.ts` only if a narrow shared path/root authorization primitive must be extracted.
- Modify/Create narrow shared helper under `services/workspace-agent/src/git/` or `services/workspace-agent/src/source-control/` for root authorization only if RED coverage proves duplication otherwise.
- Create: `services/workspace-agent/test/unit/source-control/git-process-runner.test.ts`
- Create: `services/workspace-agent/test/unit/source-control/git-repository-service.test.ts`

**Interfaces:**
- Consumes: `GitRepositoryExecutor` and six Git contracts from Task 1, protected-branch helper from Task 2.
- Produces: hardened Git mutation service; canonical GitHub origin resolution support for Task 6.

Allowed internal command templates are restricted to the operation set needed by the spec:

```text
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git rev-parse --verify refs/heads/<branch>
git check-ref-format --branch <branch>
git switch -c <branch> <expectedHeadSha>
git add -- <paths...>
git restore --staged -- <paths...>
git write-tree
git diff --cached --quiet
git diff --quiet
git commit -m <message>
git merge-base --is-ancestor <targetSha> <sourceSha>
git merge --ff-only <expectedSourceSha>
git ls-remote --heads <remote> <branch>
git push <remote> <localSha>:refs/heads/<branch>
git remote get-url origin
```

No public/general runner accepts caller argv.

- [ ] **Step 1: Write RED process-hardening tests**

Inject a fake child-process seam and assert:
- resolved Git executable is absolute;
- `shell:false`;
- caller cannot choose executable/argv/env/config;
- child env excludes `GITHUB_TOKEN`, `GH_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` unless the service itself intentionally sets a safe fixed value;
- cancellation/deadline terminates process tree;
- public error does not expose raw stderr.

- [ ] **Step 2: Write RED create/stage/unstage tests**

Use isolated repositories and prove:
- create branch rejects stale `expectedHeadSha` with `GIT_HEAD_MISMATCH`;
- existing branch rejects with `GIT_BRANCH_CONFLICT`;
- feature branch can be created from `main`;
- stage mutates only explicit validated paths and returns `indexTreeSha`;
- unstage checks both `expectedHeadSha` and `expectedIndexTreeSha`, touches only explicit paths and uses restore-staged semantics rather than reset.

- [ ] **Step 3: Write RED commit tests**

Prove:
- commit on current `main` fails `GIT_PROTECTED_BRANCH` before `git commit` invocation;
- stale HEAD -> `GIT_HEAD_MISMATCH`;
- changed index tree -> `GIT_INDEX_CHANGED`;
- normal commit returns new commit SHA and branch;
- no amend/signing/config caller field exists.

- [ ] **Step 4: Write RED fast-forward merge tests**

Prove:
- current `main` fails before merge invocation;
- target HEAD must equal `expectedTargetHeadSha`;
- source branch resolves exactly to `expectedSourceHeadSha`;
- dirty worktree or dirty index fails closed before merge;
- non-ancestor source rejects `GIT_MERGE_NOT_FAST_FORWARD`;
- successful merge uses fixed `merge --ff-only <expectedSourceHeadSha>` and returns `previousHeadSha`, `headSha`, `sourceHeadSha`, `fastForwarded:true`.

- [ ] **Step 5: Write RED push/reconciliation tests**

Prove:
- source or target `main` is blocked;
- local SHA mismatch is detected before push;
- optional remote SHA mismatch returns `GIT_REMOTE_CHANGED`;
- force flags are impossible;
- ambiguous push outcome is reconciled by `ls-remote` before deciding completed vs `SOURCE_CONTROL_RECONCILIATION_REQUIRED`.

- [ ] **Step 6: Run RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/git-process-runner.test.ts services/workspace-agent/test/unit/source-control/git-repository-service.test.ts
```

Expected: FAIL because the hardened service/runner do not exist.

- [ ] **Step 7: Implement the minimal hardened Git boundary**

Do not reuse inspection `runGitStrict()` as the mutation process boundary unless it is first refactored under RED coverage to satisfy absolute executable, allowlisted environment and sanitized-error requirements. Prefer the dedicated `git-process-runner.ts` to avoid weakening inspection behavior.

Extract only the root/path authorization primitive needed to share existing traversal/symlink/worktree checks; do not duplicate a weaker path policy.

- [ ] **Step 8: Run GREEN + Agent typecheck**

Run Step 6 plus:

```powershell
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```

- [ ] **Step 9: Static security review and local commit**

Search Task 4 production delta for:

```text
execSync
spawnSync
shell: true
--force
--force-with-lease
reset
rebase
--amend
process.env.GITHUB_TOKEN
process.env.GH_TOKEN
```

`reset`, `rebase` and amend must have zero production occurrences in the source-control mutation boundary. Commit locally:

```text
feat(agent): add hardened typed git service
```

No push.

---

### Task 5: GitHub credential provider, fixed HTTP client and five-operation GitHubService

**Files:**
- Create: `services/workspace-agent/src/source-control/github-credential-provider.ts`
- Create: `services/workspace-agent/src/source-control/gh-cli-user-credential-provider.ts`
- Create: `services/workspace-agent/src/source-control/github-http-client.ts`
- Create: `services/workspace-agent/src/source-control/github-service.ts`
- Create: `services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts`
- Create: `services/workspace-agent/test/unit/source-control/github-http-client.test.ts`
- Create: `services/workspace-agent/test/unit/source-control/github-service.test.ts`
- Modify: `packages/mcp-core/src/errors.ts` only if a focused RED proves an existing typed error category is insufficient.

**Interfaces:**
- Consumes: `GitHubExecutor` and five GitHub contracts from Task 1.
- Produces: opaque credential provider, fixed GitHub transport and typed GitHub service for Task 6.

Credential interface:

```ts
export interface GitHubCredential {
  readonly token: string;
  readonly source: "gh-cli-user" | "github-app-installation" | "account-provisioning";
}

export interface GitHubCredentialProvider {
  getCredential(context?: OperationContext): Promise<GitHubCredential>;
}
```

Fixed API configuration:

```text
base URL: https://api.github.com
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Authorization: Bearer <opaque token> (injected internally)
```

- [ ] **Step 1: Write RED `gh auth token` provider tests**

Assert exact allowed argv is only:

```text
gh auth token
```

Assert `shell:false`, no arbitrary caller args, no `gh api`, no `gh repo`, no token in thrown `AppError.message`, `cause`, returned diagnostics or logs.

- [ ] **Step 2: Write RED fixed HTTP client tests**

Assert caller cannot supply URL, method or headers. Test exact internally built request templates for:

```text
GET  /user
GET  /repos/{owner}/{repo}
POST /user/repos
POST /orgs/{owner}/repos
GET  /repos/{owner}/{repo}/pulls/{number}
POST /repos/{owner}/{repo}/pulls
PUT  /repos/{owner}/{repo}/pulls/{number}/merge
```

Include narrowly scoped fixed reconciliation query construction for PR creation. Verify raw response body and raw fetch exception are not exposed publicly.

- [ ] **Step 3: Write RED typed service and reconciliation tests**

Prove:
- repository create ambiguous outcome reconciles with repository lookup;
- PR create ambiguous outcome reconciles by exact head/base query;
- merge re-reads PR and checks `head.sha === expectedPullRequestHeadSha`;
- merge request body includes expected SHA and exact `merge_method`;
- ambiguous merge re-reads PR state/merge SHA;
- deterministic 4xx/auth/validation failures are not blindly retried.

- [ ] **Step 4: Run RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts services/workspace-agent/test/unit/source-control/github-http-client.test.ts services/workspace-agent/test/unit/source-control/github-service.test.ts
```

Expected: FAIL because provider/client/service do not exist.

- [ ] **Step 5: Implement minimal provider/client/service**

`GitHubService` implements exactly five executor methods. Public executor methods never expose credentials or generic request primitives. Every returned value is parsed against Task 1 result schemas.

- [ ] **Step 6: Run GREEN + Agent typecheck**

Run Step 4 plus:

```powershell
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```

- [ ] **Step 7: Secret/redaction gate and local commit**

Run official Gitleaks over Task 5 paths and static search for `gh api`, arbitrary caller URL/header/method, `console.*` containing credential/header data, `process.env.GITHUB_TOKEN`, `process.env.GH_TOKEN`, raw response bodies and raw transport causes. Commit locally:

```text
feat(agent): add typed github api service
```

No push.

---

### Task 6: LocalAgent authorization, protected branches, receipts, audit and strict relay routing

**Files:**
- Modify: `packages/mcp-core/src/contracts.ts`
- Modify: `packages/mcp-core/src/audit.ts`
- Modify: `packages/mcp-core/src/relay-retry-policy.ts`
- Modify: `services/workspace-agent/src/internal-types.ts`
- Modify: `services/workspace-agent/src/workspace-registry.ts`
- Modify: `services/workspace-agent/src/local-agent.ts`
- Modify: `services/workspace-agent/src/connection/request-dispatcher.ts`
- Modify: `services/workspace-agent/src/connection/request-executor.ts`
- Modify: `services/workspace-agent/src/connection/service.ts`
- Modify: `services/workspace-agent/src/in-process-workspace-executor.ts`
- Modify: `services/workspace-agent/src/remote/ssh-workspace-executor.ts` only if the supported runtime requires direct typed source-control parity there; otherwise fail closed explicitly and cover that behavior.
- Modify: `services/workspace-agent/src/subprocess-workspace-executor.ts`
- Modify: `services/mcp-gateway/src/relay/workspace-executor.ts`
- Modify: `services/mcp-gateway/src/relay/request-manager.ts` only for strict context/result handling, not mutation retries.
- Create: `services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts`
- Modify: `services/workspace-agent/test/unit/connection/request-dispatcher.test.ts`
- Modify: `services/workspace-agent/test/unit/connection/request-executor.test.ts`
- Modify: `services/workspace-agent/test/e2e/agent-connection.test.ts`
- Create: `services/mcp-gateway/test/unit/relay/source-control-workspace-executor.test.ts`
- Modify: `services/mcp-gateway/test/unit/relay/request-manager.test.ts`
- Modify: `services/mcp-gateway/test/integration/relay/service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: eleven LocalAgent typed methods, eleven strict internal relay operations, sanitized audit metadata and context propagation. Public MCP tool catalog remains unchanged until Task 7.

Internal relay operations exactly:

```ts
const sourceControlRelayOperations = [
  "gitCreateBranch",
  "gitStagePaths",
  "gitUnstagePaths",
  "gitCommit",
  "gitMergeBranch",
  "gitPushBranch",
  "githubGetRepository",
  "githubCreateRepository",
  "githubGetPullRequest",
  "githubCreatePullRequest",
  "githubMergePullRequest",
] as const;
```

Serializable context fields exactly:

```ts
{
  correlationId?: string;
  invocationId?: string;
  idempotencyKey?: string;
  ownerScope?: string;
}
```

- [ ] **Step 1: Write RED LocalAgent authorization tests**

Create fixtures with injectable fake Git/GitHub executors, confirmation registry and receipt store. Prove capability denial happens before backend invocation for each domain. Specifically prove `git.merge.write` is independently required and stage/unstage share `git.index.write`.

- [ ] **Step 2: Write RED protected-branch LocalAgent tests**

Prove direct commit/current-main, merge/current-main and push source/destination-main fail before backend mutation; branch creation from main remains allowed when SHA precondition passes.

- [ ] **Step 3: Write RED confirmation/idempotency tests**

Prove:
- first push/create-repository/create-PR/merge-PR call returns typed confirmation-required result;
- exact confirmation binding allows execution;
- changed args/target cannot reuse a grant;
- completed same-identity replay does not call backend again and does not consume another confirmation;
- same idempotency key with changed identity throws conflict;
- ambiguous/executing receipt state does not invoke backend blindly.

- [ ] **Step 4: Write RED canonical GitHub target tests**

Resolve exact canonical repository from:

```text
git@github.com:owner/repo.git
https://github.com/owner/repo.git
ssh://git@github.com/owner/repo.git
```

Reject malformed, query-bearing and non-GitHub origins unless the requested repository is in `additionalRepositories`.

- [ ] **Step 5: Run LocalAgent RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts
```

- [ ] **Step 6: Implement LocalAgent source-control pipeline**

For each repository-scoped operation execute in this order:

```text
parse -> workspace/root -> typed target -> capability/target -> protected branch -> completed replay/conflict -> typed confirmation -> reserve/executing receipt -> one backend call -> result parse -> receipt complete -> sanitized audit
```

For mutations without `context.idempotencyKey`, derive a stable operation key from confirmation id when present, otherwise `invocationId`, otherwise `correlationId`; if none exists, fail `INVALID_ARGUMENT`. Do not derive from credentials or retry-local randomness.

Audit additions are limited to:

```ts
sourceControlCapability?: SourceControlCapability;
targetResource?: string;
expectedSha?: string;
resultSha?: string;
idempotencyOutcome?: "executed" | "completed_replay" | "confirmation_required";
```

- [ ] **Step 7: Write RED relay request/result/context tests**

Prove all eleven operations parse exact inputs/results, reject unknown `rawArgs`/credential-like fields, map Gateway -> one relay call -> Agent dispatcher -> one LocalAgent method, preserve serializable context, keep `signal` local and deadline in the envelope.

Agent hello capability names must derive from one authoritative relay-operation source rather than a manually duplicated list.

- [ ] **Step 8: Write RED relay retry classification tests**

Assert only `githubGetRepository` and `githubGetPullRequest` are eligible for existing read-only/idempotent bounded retry. Assert all six Git mutations and the three GitHub mutations are not in `RETRYABLE_RELAY_OPERATIONS`.

- [ ] **Step 9: Implement strict relay routing**

Extend `relayOperationSchema`, request discriminated union, result map and executor methods. Do not register public source-control MCP names in Task 6.

- [ ] **Step 10: Run focused GREEN**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts services/workspace-agent/test/unit/connection/request-dispatcher.test.ts services/workspace-agent/test/unit/connection/request-executor.test.ts services/workspace-agent/test/e2e/agent-connection.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/unit/relay/source-control-workspace-executor.test.ts services/mcp-gateway/test/unit/relay/request-manager.test.ts services/mcp-gateway/test/integration/relay/service.test.ts
```

- [ ] **Step 11: Run affected type/build/security gates and local commit**

```powershell
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
npx tsc --noEmit -p services/mcp-gateway/tsconfig.json
```

Then run diff-check, secret-scan and static search for generic relay execute operations, credential fields, mutation retry classification and source-control public MCP registration. Commit locally:

```text
feat(relay): route typed source control operations
```

No push.

---

### Task 7: Register exactly eleven MCP tools and regenerate catalog/Edge identity

**Files:**
- Modify: `packages/mcp-core/src/mcp-workspace-tools.ts`
- Modify: `packages/mcp-core/src/mcp-tool-catalog.ts`
- Modify: `packages/mcp-core/test/mcp-workspace-tools.test.ts`
- Modify: `packages/mcp-core/test/mcp-tool-catalog.test.ts`
- Modify: `services/mcp-gateway/src/mcp/server.ts`
- Modify: `services/mcp-gateway/src/app.ts`
- Modify: `services/mcp-gateway/test/support/helpers.ts` only if a typed source-control fake is needed.
- Modify: `services/mcp-gateway/test/integration/mcp/tools-list.test.ts`
- Modify: `services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts`
- Modify: `services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts`
- Modify: `services/mcp-gateway/test/integration/http/gateway.test.ts`
- Regenerate: `services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts`
- Use existing generator: `tooling/mcp/generate-edge-control-plane-manifest.ts`.

**Interfaces:**
- Consumes: Task 1 ports/contracts and Task 6 relay-backed executor.
- Produces: exact eleven public source-control MCP tools, full catalog count 61, workspace/Edge count 28 and regenerated catalog identity.

Required tool annotations:

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

- [ ] **Step 1: Write MCP registration RED tests**

Assert source-control public names equal exactly the eleven names and each handler calls exactly one corresponding typed method with parsed input and operation context. Assert old tools remain present and authentication metadata unchanged.

- [ ] **Step 2: Write catalog-count RED tests**

Update expected full catalog from 50 to 61 and workspace-only catalog from 17 to 28. Assert no twelfth source-control name exists.

- [ ] **Step 3: Run RED**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/mcp-workspace-tools.test.ts packages/mcp-core/test/mcp-tool-catalog.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/integration/mcp/tools-list.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts services/mcp-gateway/test/integration/http/gateway.test.ts
```

Expected: FAIL because the eleven tools are not yet registered/catalogued.

- [ ] **Step 4: Implement public registration without port fusion**

`McpServerOptions` carries `workspaceExecutor` separately from `sourceControlExecutor: GitRepositoryExecutor & GitHubExecutor`. The production Gateway may pass the same relay-backed object for both interfaces, but public types remain separate.

Register each tool with exact schema/result parse and annotations. Add all eleven public names to `relayOperationToToolName` only now.

- [ ] **Step 5: Derive new descriptor/catalog revision using canonical code**

Use the same real `createMcpServer` projection/generator path already used by the repository. Do not type a guessed revision. Update `MCP_TOOL_CATALOG_CONTRACT_REVISION` only with the value computed from the actual 61-tool descriptor set.

- [ ] **Step 6: Regenerate Edge manifest canonically**

Run:

```powershell
npx tsx tooling/mcp/generate-edge-control-plane-manifest.ts
npx tsx tooling/mcp/generate-edge-control-plane-manifest.ts --check
```

Then run the manifest parity test and assert generated `toolCount` is exactly 28 and all eleven source-control names are present.

- [ ] **Step 7: Run GREEN + Edge check**

Run Step 3 commands plus:

```powershell
npm run typecheck
npm run build
npm run check:edge
```

Expected: exit 0; Edge command is dry-run only.

- [ ] **Step 8: Review and local commit**

Run official diff-check/secret-scan. Confirm no credentials/confirmation ids are emitted into manifest metadata. Commit locally:

```text
feat(mcp): register typed source control tools
```

No push.

---

### Task 8: Final source-control public-boundary, security and regression gate

**Files:**
- Create: `packages/mcp-core/test/source-control-public-boundary.test.ts`
- Create: `services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts`
- Modify production files only when one of these final invariant tests produces a concrete RED; any correction must be narrowly scoped and retain its own RED/GREEN evidence.

**Interfaces:**
- Consumes: completed Tasks 1–7.
- Produces: executable invariants proving exact public surface, capability set, no escape hatches, result redaction, protected branches, relay safety and generated catalog parity.

- [ ] **Step 1: Add exact public-boundary invariant test**

Assert exact eleven-tool set:

```ts
expect(publicSourceControlNames.sort()).toEqual([
  "git_commit",
  "git_create_branch",
  "git_merge_branch",
  "git_push_branch",
  "git_stage_paths",
  "git_unstage_paths",
  "github_create_pull_request",
  "github_create_repository",
  "github_get_pull_request",
  "github_get_repository",
  "github_merge_pull_request",
].sort());
```

Assert exact ten-capability set and recursively reject forbidden keys such as `command`, `args`, `argv`, `force`, `forceWithLease`, `url`, `headers`, `authorization`, `token`, `strategy`, `rebase`, `reset` where they are not explicit safe domain fields.

- [ ] **Step 2: Add MCP integration boundary test**

Invoke all eleven tools through `createMcpServer` with fake source-control executors. Prove exact input -> exactly one typed method -> exact structured result. Inject extra backend fields such as `authorization`, `token`, `rawResponse`, `stderr` and prove strict result parsing rejects them and emits none.

Prove operation context contains correlation/invocation/owner/deadline fields and confirmation-capable inputs carry only opaque `confirmationId`, never credentials.

- [ ] **Step 3: Run Task 8 tests before any correction**

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-public-boundary.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts
```

If both are GREEN, record no production correction required. If either is RED, preserve the failing evidence, implement only the defect exposed, and rerun until GREEN.

- [ ] **Step 4: Run complete Phase 4 focused regression**

Run all source-control core/agent/gateway test files explicitly, including:
- contracts/executor/policy/confirmation/receipts/public-boundary;
- Git process/service;
- GitHub provider/client/service;
- LocalAgent source-control integration;
- request-dispatcher/request-executor/agent e2e;
- relay executor/request manager/service;
- MCP source-control tools/catalog/tool-list/catalog-sync.

Use explicit `--runTestsByPath` groups so a skipped discovery pattern cannot masquerade as coverage.

- [ ] **Step 5: Run full affected suites and build gates**

Run:

```powershell
npm run test:mcp-core
npm run test:mcp-gateway:unit
npm run test:mcp-gateway:integration
npm run test:mcp-gateway:e2e
npm run test:workspace-agent:unit
npm run test:workspace-agent:integration
npm run test:workspace-agent:e2e
npm run typecheck
npm run build
npm run check:edge
```

For the known Gateway environment-isolation issue, run the unit suite with `AUTH_MODE` absent only in that child process if inherited `AUTH_MODE=owner` triggers the already-documented default-auth test; do not modify unrelated production behavior.

- [ ] **Step 6: Run repository-wide heavy regression**

Run `npm run check` as a persisted background task when the runtime supports it. Use `wait_background_task` to obtain terminal state rather than caller polling. A timeout of the wait is not a task failure; only terminal task result determines PASS/FAIL.

- [ ] **Step 7: Run final static/security gates**

Required:
- official `diff-check`, scope changes;
- official `secret-scan`, scope changes, Gitleaks;
- UTF-8/BOM scan for all new/modified source-control files;
- static production-delta search for `gh api`, `execSync`, `spawnSync`, `shell: true`, force push/history rewrite, raw `GITHUB_TOKEN`/`GH_TOKEN`, caller-provided URL/header/argv/config and generic source-control execute operations;
- verify mutation operations absent from relay automatic retry allowlist;
- verify public source-control tools = 11;
- capabilities = 10;
- full catalog = 61;
- Edge workspace manifest = 28;
- manifest generator `--check` passes.

- [ ] **Step 8: Revalidate original operational checkout**

Verify branch `feat/minimal-windows-execution-node`, exactly the known 19 pre-existing modified `.ps1` files, staging empty and no unexpected non-`.codex` write.

- [ ] **Step 9: Close Phase 4 and create final local Task 8/Phase 4 commit**

If Task 8 adds only invariant tests, commit them locally with:

```text
test(source-control): harden typed source control boundary
```

If a production correction was required, include only the exact reviewed correction files in the same final Phase 4 gate after RED/GREEN evidence is recorded.

Update exactly the six `.codex` files to the Phase 4 complete checkpoint after the local commit. No push.

---

## Spec coverage map

| Spec requirement | Plan task(s) |
| --- | --- |
| Exact 11 tools / no generic escape hatch | 1, 7, 8 |
| Exact 10 capabilities | 2, 8 |
| Stage + unstage explicit paths | 1, 4, 8 |
| Fast-forward-only local merge | 1, 2, 4, 6, 8 |
| Protected `main` | 2, 4, 6, 8 |
| Separate Git/GitHub ports | 1, 4, 5, 7 |
| Typed confirmation | 3, 6, 8 |
| Mutation receipts/idempotency/reconciliation | 3, 4, 5, 6, 8 |
| Hardened Git process boundary | 4, 8 |
| Fixed GitHub credential/HTTP boundary | 5, 8 |
| LocalAgent typed pipeline + audit | 6, 8 |
| Strict relay/context/hello + retry safety | 6, 8 |
| MCP catalog 61 / Edge 28 | 7, 8 |
| TDD + regression/security gates | 1–8 |
| Operational checkout preservation | 8 |

## Final completion criteria

Phase 4 is not complete until:

- Tasks 1–8 have fresh RED/GREEN/review evidence;
- all eleven typed tools and ten capabilities exist with no additional generic source-control surface;
- local Git mutations use the hardened typed Git service;
- GitHub operations use fixed typed API endpoints and isolated credentials;
- protected `main`, confirmation and idempotency/reconciliation rules are executable invariants;
- relay mutation retries remain fail-safe;
- full catalog = 61 and Edge workspace manifest = 28 with canonical identity/parity checks GREEN;
- affected full suites, root typecheck/build, Edge dry-run, diff-check and Gitleaks are GREEN;
- original operational checkout remains untouched outside permitted `.codex` state;
- Phase 4 commits remain local; remote branch remains at the Phase 1 snapshot until the final roadmap integration gate.

## Execution handoff

Execute this plan task-by-task in the existing isolated cumulative worktree. The current conversation has been operating inline with explicit checkpoints, so the natural execution mode is `superpowers:executing-plans`. Do not start Task 2 until Task 1 RED/GREEN/review and local commit are complete. Do not push any Task commit.
