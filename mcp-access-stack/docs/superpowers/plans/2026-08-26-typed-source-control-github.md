# Typed Git/GitHub Source-Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the approved nine-operation typed Git/GitHub source-control boundary on the durable recovery branch without arbitrary command escape hatches, with explicit policy, typed confirmation, mutation reconciliation, sanitized credentials/audit, strict relay integration, and first-class MCP registration.

**Architecture:** Keep local Git and GitHub API operations behind separate `GitRepositoryExecutor` and `GitHubExecutor` ports. MCP tools call those typed ports; Gateway maps them one-to-one onto strict relay operations; LocalAgent performs policy/target/confirmation/idempotency checks before invoking hardened Git/GitHub services. The reconstruction is based on `4d5747957d5512ef61827761efe00b045188502b`; the divergent `e73316b…` line is observation-only and is never merged implicitly.

**Tech Stack:** TypeScript, Node.js, Zod, Jest, MCP SDK, Git CLI via `spawn(..., { shell: false })`, GitHub REST API via `fetch`, PowerShell only for repository orchestration/validation.

**Spec:** `docs/superpowers/specs/2026-08-26-typed-source-control-github-design.md` (reconstituted approved SHA-256 `0c046147fc93bf776e740e8545f98bdfb79a0bf24233bb8ace1539613d5b1e63`)

## Provenance

Historical plan path: `docs/superpowers/plans/2026-08-26-typed-source-control-github.md`.
Historical SHA-256: `285cec19dc6d460e445ba0cc1420de6c025a769a1517db81c5112bf8c82c2fca`.

This file is a semantic reconstruction, not a byte-identical recovery. Tasks 1–7 preserve the known historical sequence. Task 8 is explicitly newly specified as the final end-to-end/security gate because the exact historical Task 8 text was not recovered.

## Global Constraints

- Authoritative Git boundary: `%USERPROFILE%\MCP-GPT-Boundaries\mcp-access-stack-typed-source-control`.
- Branch: `recovery/typed-source-control`; starting HEAD: `4d5747957d5512ef61827761efe00b045188502b`.
- Do not merge/cherry-pick `recovery/observed-main-e73316b` without a separate reviewed decision.
- Use only MCP GPT OFICIAL V3 for repository/runtime work.
- TDD is mandatory: observe the focused RED before production implementation for every behavioral task.
- Preserve the checkout operational boundary; no writes there except ignored `.codex` checkpoint files.
- No reset/clean/stash/destructive checkout, force push, history rewrite, branch deletion, arbitrary `gh api`, raw Git argv, raw GitHub URL/header, or permanent PAT.
- No commit until the user explicitly authorizes that Task's commit gate. A `Prossiga` after a stated commit gate authorizes only that commit/next stated gate, not push/deploy.
- No push, real GitHub mutation, release, deploy, activation, restart, or cutover without separate explicit authorization.
- Historical PASS results from the lost scratch are provenance only; every reconstructed Task needs fresh evidence.
- Heavy repository-wide gates should run as persisted/background V3 tasks when they exceed the synchronous window.
- Source-control public V1 surface is exactly nine tools and exactly nine capabilities.

## Canonical V1 Contract Matrix

All schemas are `.strict()`. All inputs contain `workspaceId`; repository-local operations also accept optional `root`. `confirmationId` is optional only on operations that can require typed confirmation.

| Operation | Required operation-specific input | Optional input | Result core fields |
| --- | --- | --- | --- |
| `git_create_branch` | `branch`, `expectedHeadSha` | `root` | `root`, `branch`, `headSha` |
| `git_stage_paths` | non-empty unique `paths` | `root` | `root`, `headSha`, `indexTreeSha`, `paths` |
| `git_commit` | `message`, `expectedHeadSha`, `expectedIndexTreeSha` | `root` | `root`, `branch`, `commitSha` |
| `git_push_branch` | `branch`, `expectedLocalSha` | `root`, `remote`=`origin`, `expectedRemoteSha`, `confirmationId` | `root`, `remote`, `branch`, `localSha`, `remoteSha` |
| `github_get_repository` | `owner`, `repository` | `root` | `owner`, `name`, `fullName`, `defaultBranch`, `visibility`, `url` |
| `github_create_repository` | `owner`, `name`, `visibility` | `description`, `confirmationId` | repository result above |
| `github_get_pull_request` | `owner`, `repository`, `pullNumber` | `root` | `number`, `state`, `title`, `url`, `headSha`, `baseSha`, `merged` |
| `github_create_pull_request` | `owner`, `repository`, `title`, `head`, `base` | `root`, `body`, `draft`, `confirmationId` | pull-request result above |
| `github_merge_pull_request` | `owner`, `repository`, `pullNumber`, `expectedPullRequestHeadSha`, `mergeMethod` (`merge` or `squash`) | `root`, `confirmationId` | `number`, `merged`, `mergeSha` |

Validation primitives:

- Git SHA: lowercase/uppercase hexadecimal 40 characters normalized to lowercase.
- Git branch: 1–255 chars, reject control chars, whitespace-only names, leading `-`, `..`, `@{`, backslash, `~`, `^`, `:`, `?`, `*`, `[`, trailing `.`, trailing `/`, and `.lock` suffix segments.
- Git paths: workspace-relative POSIX-normalized strings; reject absolute paths, `..` traversal, `.git` internals, duplicates; max 200 entries.
- Commit message: trimmed 1–4000 chars; no NUL.
- GitHub owner/repository: GitHub-compatible safe slug, 1–100 chars, no slash/path traversal; `fullName` is `owner/repository`.
- Pull number: positive integer.
- Visibility: `private | public | internal`; service must reject `internal` when GitHub API/provider reports it is not accepted for the target owner instead of silently changing visibility.
- `expectedRemoteSha` omission means the caller does not assert the prior remote SHA; the service must still snapshot and detect an intra-operation remote change before publishing/reconciling.

### Structured confirmation result

The four operations that can require typed confirmation (`git_push_branch`, `github_create_repository`, `github_create_pull_request`, `github_merge_pull_request`) return a strict discriminated union. Define `confirmableSourceControlOperationNameSchema = z.enum(["git_push_branch", "github_create_repository", "github_create_pull_request", "github_merge_pull_request"])`; the generic `sourceControlOperationNameSchema` contains all nine V1 names. The first authorized-but-unconfirmed call returns:

```ts
export const sourceControlConfirmationRequiredSchema = z.object({
  status: z.literal("confirmation_required"),
  confirmationId: z.string().min(1).max(128),
  expiresAt: z.string().datetime(),
  operation: confirmableSourceControlOperationNameSchema,
  targetResource: z.string().min(1).max(512),
}).strict();
```

The successful mutation variant carries `status: "completed"` plus the result fields from the matrix. Backend services in Tasks 4–5 only produce the completed variant; LocalAgent Task 6 may return the confirmation-required variant before invoking a backend. Read operations remain direct strict result objects.
Exact V1 capabilities:

```ts
export const sourceControlCapabilities = [
  "git.branch.write",
  "git.index.write",
  "git.commit.write",
  "git.remote.push",
  "github.repository.read",
  "github.repository.create",
  "github.pull_request.read",
  "github.pull_request.create",
  "github.pull_request.merge",
] as const;
```

## Spec Coverage Map

| Design requirement | Implemented/proved by |
| --- | --- |
| §1 objective / typed least-privilege boundary | Global constraints; Tasks 1–8 |
| §2 non-goals / no raw Git, `gh`, URL/header, force/history rewrite or PAT | Tasks 1, 4, 5 and Task 8 static/public-boundary gate |
| §3 exact nine public tools | Task 1 contracts; Task 7 registration; Task 8 exact-set invariant |
| §4 exact nine capabilities and target policy | Task 2; Task 6 authorization; Task 8 exact-set invariant |
| §5 strict contracts and separate Git/GitHub ports | Task 1; Task 7 keeps `sourceControlExecutor` separate from `WorkspaceExecutor` |
| §6 typed confirmation | Task 3 registry; Task 6 operation binding; Task 8 integration |
| §7 idempotency/reconciliation | Task 3 receipt stores; Tasks 4–6 reconciliation; Task 8 regression |
| §8 hardened `GitRepositoryService` | Task 4; Task 8 static gate |
| §9 GitHub credential/HTTP boundary | Task 5; Task 8 redaction/secret gate |
| §10 LocalAgent pipeline/canonical origin | Task 6 LocalAgent tests and implementation |
| §11 strict relay/context/hello | Task 6 relay tests and implementation |
| §12 sanitized audit/errors | Tasks 1, 5, 6; Task 8 leakage assertions |
| §13 first-class MCP registration/catalog | Task 7; Task 8 MCP integration |
| §14 TDD/verification | Every behavioral Task; Task 8 global gates |
| §15 sequencing boundary | Tasks 1–8 in this plan; Task 8 explicitly marked reconstructed-new |
| §16 acceptance criteria | Task 8 plus Final Completion Criteria |

---

### Task 1: Strict source-control contracts and executor ports

**Files:**
- Create: `packages/mcp-core/src/source-control-contracts.ts`
- Create: `packages/mcp-core/src/source-control-executor.ts`
- Modify: `packages/mcp-core/src/errors.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Test: `packages/mcp-core/test/source-control-contracts.test.ts`
- Test: `packages/mcp-core/test/source-control-executor.test.ts`

**Interfaces:**
- Consumes: existing `OperationContext` from `packages/mcp-core/src/contracts.ts`.
- Produces: all nine strict input/result schemas/types plus `GitRepositoryExecutor` and `GitHubExecutor` used by Tasks 4–7.

```ts
export interface GitRepositoryExecutor {
  createBranch(input: GitCreateBranchInput, context?: OperationContext): Promise<GitCreateBranchResult>;
  stagePaths(input: GitStagePathsInput, context?: OperationContext): Promise<GitStagePathsResult>;
  commit(input: GitCommitInput, context?: OperationContext): Promise<GitCommitResult>;
  pushBranch(input: GitPushBranchInput, context?: OperationContext): Promise<GitPushBranchResult>;
}

export interface GitHubExecutor {
  getRepository(input: GitHubGetRepositoryInput, context?: OperationContext): Promise<GitHubRepositoryResult>;
  createRepository(input: GitHubCreateRepositoryInput, context?: OperationContext): Promise<GitHubRepositoryResult>;
  getPullRequest(input: GitHubGetPullRequestInput, context?: OperationContext): Promise<GitHubPullRequestResult>;
  createPullRequest(input: GitHubCreatePullRequestInput, context?: OperationContext): Promise<GitHubPullRequestResult>;
  mergePullRequest(input: GitHubMergePullRequestInput, context?: OperationContext): Promise<GitHubMergePullRequestResult>;
}
```

- [ ] **Step 1: Write contract RED tests for exact fields and forbidden escape hatches**

```ts
expect(gitPushBranchInputSchema.parse({
  workspaceId: "repo",
  branch: "feature/x",
  expectedLocalSha: "a".repeat(40),
}).remote).toBe("origin");
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

Also test all matrix fields, SHA normalization, invalid branch names, path traversal/`.git`, duplicate stage paths, unknown fields, PR number, visibility and merge-method enums. Test the confirmation-required discriminant and prove the four confirmable result schemas accept only the exact confirmation-required or completed variant.

- [ ] **Step 2: Run the focused tests and capture RED**

Run:
```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts
```
Expected: FAIL because the source-control modules/exports do not exist.

- [ ] **Step 3: Implement strict schemas/types and ports**

Implement the matrix exactly in `source-control-contracts.ts`. Export schema/type pairs named:
`gitCreateBranchInputSchema`, `gitCreateBranchResultSchema`, `gitStagePathsInputSchema`, `gitStagePathsResultSchema`, `gitCommitInputSchema`, `gitCommitResultSchema`, `gitPushBranchInputSchema`, `gitPushBranchResultSchema`, `githubGetRepositoryInputSchema`, `githubRepositoryResultSchema`, `githubCreateRepositoryInputSchema`, `githubGetPullRequestInputSchema`, `githubPullRequestResultSchema`, `githubCreatePullRequestInputSchema`, `githubMergePullRequestInputSchema`, `githubMergePullRequestResultSchema`, `sourceControlConfirmationRequiredSchema`, `sourceControlOperationNameSchema`, `confirmableSourceControlOperationNameSchema`, plus reusable `gitShaSchema`, `gitBranchSchema`, `githubOwnerSchema`, `githubRepositoryNameSchema`, `githubRepositoryFullNameSchema`.

Add these error codes in `errors.ts`, for use by later Tasks:

```ts
"SOURCE_CONTROL_CAPABILITY_DENIED",
"SOURCE_CONTROL_CONFIRMATION_INVALID",
"SOURCE_CONTROL_IDEMPOTENCY_CONFLICT",
"SOURCE_CONTROL_RECONCILIATION_REQUIRED",
"GIT_HEAD_MISMATCH",
"GIT_BRANCH_CONFLICT",
"GIT_INDEX_CHANGED",
"GIT_REMOTE_CHANGED",
```

Re-export both new modules from `index.ts`.

- [ ] **Step 4: Run GREEN + core typecheck**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
```
Expected: both commands exit 0.

- [ ] **Step 5: Review Task 1 diff/security**

Verify `git diff --check`, no `force`, raw command/argv/url/header input fields, and no credentials. Confirm only Task 1 files are staged when the commit gate is reached.

- [ ] **Step 6: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add packages/mcp-core/src/source-control-contracts.ts packages/mcp-core/src/source-control-executor.ts packages/mcp-core/src/errors.ts packages/mcp-core/src/index.ts packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts
git commit -m "feat(mcp): add typed source control contracts"
```

---

### Task 2: Explicit source-control policy and target authorization

**Files:**
- Create: `packages/mcp-core/src/source-control-policy.ts`
- Modify: `packages/mcp-core/src/policy.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Modify: `config/workspace-policy.example.json`
- Test: `packages/mcp-core/test/source-control-policy.test.ts`
- Test: `packages/mcp-core/test/loopback-policy.test.ts`
- Test: `packages/mcp-core/test/policy-merge.test.ts` (regression only; production `policy-merge.ts` should remain unchanged unless this test proves a defect)

**Interfaces:**
- Consumes: `SourceControlCapability` and GitHub full-name primitives from Task 1; `WorkspacePolicy`/`PermissionProfile`.
- Produces: optional `WorkspacePolicy.sourceControl`, `sourceControlPolicySchema`, and `assertSourceControlCapability()` for LocalAgent Task 6.

```ts
export const sourceControlPolicySchema = z.object({
  capabilities: z.array(sourceControlCapabilitySchema).default([]),
  accountOwners: z.array(githubOwnerSchema).default([]),
  additionalRepositories: z.array(githubRepositoryFullNameSchema).default([]),
}).strict();

export function assertSourceControlCapability(input: {
  policy: Pick<WorkspacePolicy, "permissionProfile" | "sourceControl">;
  capability: SourceControlCapability;
  repository?: string;
  canonicalRepository?: string;
  accountOwner?: string;
  mutation: boolean;
}): void;
```

- [ ] **Step 1: Write RED tests**

Cover: legacy policy parses with no `sourceControl`; exact capability required; mutation denied unless `full-repo-write`; read allowed independently of shell permission; canonical repository allowed; different repository denied unless in `additionalRepositories`; repository creation owner denied unless in `accountOwners`. Add a `policy-merge.test.ts` regression proving an explicit workspace preserves its parsed `sourceControl` object unchanged while a discovered workspace receives no `sourceControl` privileges.

```ts
expect(() => assertSourceControlCapability({
  policy: writablePolicy({ capabilities: ["github.repository.read"] }),
  capability: "github.repository.read",
  repository: "acme/other",
  canonicalRepository: "acme/app",
  mutation: false,
})).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
```

- [ ] **Step 2: Run RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/loopback-policy.test.ts packages/mcp-core/test/policy-merge.test.ts
```
Expected: new policy tests fail before production support.

- [ ] **Step 3: Implement additive fail-closed policy**

Add optional `sourceControl` to `workspacePolicySchema`; preserve legacy behavior when omitted. Do not add custom source-control merge logic unless the RED regression demonstrates a defect: the current merge passes explicit `WorkspacePolicy` objects through and discovered workspaces are constructed without `sourceControl`. Export `assertSourceControlCapability` and keep error messages target-safe.

Update the example JSON with an explicit example block containing all three arrays but no credentials.

- [ ] **Step 4: Run GREEN + core regression/typecheck**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/loopback-policy.test.ts packages/mcp-core/test/policy-merge.test.ts
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
```
Expected: exit 0.

- [ ] **Step 5: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add packages/mcp-core/src/source-control-policy.ts packages/mcp-core/src/policy.ts packages/mcp-core/src/index.ts config/workspace-policy.example.json packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/loopback-policy.test.ts packages/mcp-core/test/policy-merge.test.ts
git commit -m "feat(policy): add source control capabilities"
```

---

### Task 3: Typed confirmation and mutation receipts

**Files:**
- Create: `packages/mcp-core/src/typed-confirmation.ts`
- Create: `packages/mcp-core/src/mutation-receipts.ts`
- Modify: `packages/mcp-core/src/index.ts`
- Create: `services/workspace-agent/src/source-control/file-mutation-receipt-store.ts`
- Test: `packages/mcp-core/test/typed-confirmation.test.ts`
- Test: `packages/mcp-core/test/mutation-receipts.test.ts`
- Test: `services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts`

**Interfaces:**
- Consumes: `OperationContext.idempotencyKey`, `AppError`, typed operation names/targets from Task 1.
- Produces: `TypedConfirmationRegistry`, canonical argument digest helpers, `MutationReceiptStore`, `InMemoryMutationReceiptStore`, and `FileMutationReceiptStore` used by Task 6.

```ts
export interface TypedConfirmationBinding {
  workspaceId: string;
  operation: string;
  targetResource: string;
  canonicalArgumentsDigest: string;
}

export interface MutationReceiptIdentity extends TypedConfirmationBinding {
  idempotencyKey: string;
}

export type MutationReceiptState =
  | "reserved"
  | "executing"
  | "completed"
  | "reconciliation_required";
```

- [ ] **Step 1: Write confirmation RED tests**

Prove TTL <= 10 minutes, one-shot consume, argument/target/workspace/operation mismatch rejection without consuming the original grant, expiry rejection, and canonical digest stability independent of object key order.

- [ ] **Step 2: Write receipt RED tests**

Prove reserve -> executing -> completed; completed same identity replay; same idempotency key + different binding throws `SOURCE_CONTROL_IDEMPOTENCY_CONFLICT`; executing/reconciliation states cannot blind retry; stored records never contain credential fields.

For file store, prove atomic temp-write/rename semantics, reload persistence, per-idempotency-key serialization and restrictive runtime-private directory placement.

- [ ] **Step 3: Run RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/typed-confirmation.test.ts packages/mcp-core/test/mutation-receipts.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts
```
Expected: FAIL before modules exist.

- [ ] **Step 4: Implement confirmation + receipt stores**

`TypedConfirmationRegistry.issue(binding, ttlMs)` returns an opaque confirmation id; `consume(id, binding)` validates exact canonical binding and one-shot semantics. Do not derive authorization from command strings.

`MutationReceiptStore` must expose typed operations equivalent to:

```ts
interface MutationReceiptStore {
  get(idempotencyKey: string): Promise<MutationReceipt | undefined>;
  reserve(identity: MutationReceiptIdentity): Promise<MutationReceipt>;
  markExecuting(identity: MutationReceiptIdentity): Promise<void>;
  complete(identity: MutationReceiptIdentity, result: unknown): Promise<void>;
  markReconciliationRequired(identity: MutationReceiptIdentity): Promise<void>;
}
```

Persist only validated public result data and canonical identity metadata. Never persist credential providers, Authorization, raw errors or confirmation secrets.

- [ ] **Step 5: Run GREEN + affected typechecks**

Run the two commands from Step 3, then:

```bash
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```
Expected: exit 0.

- [ ] **Step 6: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add packages/mcp-core/src/typed-confirmation.ts packages/mcp-core/src/mutation-receipts.ts packages/mcp-core/src/index.ts services/workspace-agent/src/source-control/file-mutation-receipt-store.ts packages/mcp-core/test/typed-confirmation.test.ts packages/mcp-core/test/mutation-receipts.test.ts services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts
git commit -m "feat(source-control): add confirmation and mutation receipts"
```

---

### Task 4: Hardened local Git repository service

**Files:**
- Create: `services/workspace-agent/src/source-control/git-repository-service.ts`
- Test: `services/workspace-agent/test/unit/source-control/git-repository-service.test.ts`
- Test support: `services/workspace-agent/test/support/helpers.ts` only if the existing Git fixture needs a narrowly scoped helper.

**Interfaces:**
- Consumes: `GitRepositoryExecutor` and four Git contracts from Task 1.
- Produces: `GitRepositoryService` and hardened internal `runGitChecked()` behavior used by Task 6 canonical-origin resolution.

```ts
export class GitRepositoryService implements GitRepositoryExecutor {
  createBranch(input: GitCreateBranchInput, context?: OperationContext): Promise<GitCreateBranchResult>;
  stagePaths(input: GitStagePathsInput, context?: OperationContext): Promise<GitStagePathsResult>;
  commit(input: GitCommitInput, context?: OperationContext): Promise<GitCommitResult>;
  pushBranch(input: GitPushBranchInput, context?: OperationContext): Promise<GitPushBranchResult>;
}
```

- [ ] **Step 1: Write RED tests for process hardening**

Inject a fake spawn/process runner and assert: absolute Git executable; `shell:false`; argv constructed internally; no raw caller argv/config/env; child env allowlist excludes token/OIDC/Git credential variables; cancellation/deadline terminates child; raw stderr is sanitized.

```ts
expect(spawnCall.options.shell).toBe(false);
expect(spawnCall.argv).not.toContain("--force");
expect(Object.keys(spawnCall.options.env)).not.toEqual(expect.arrayContaining([
  "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"
]));
```

- [ ] **Step 2: Write RED tests for Git state/preconditions**

Use isolated fixture repositories. Prove:
- create branch checks `expectedHeadSha`, rejects conflict with `GIT_BRANCH_CONFLICT`;
- stage only explicit validated paths and returns `indexTreeSha`;
- commit checks both expected HEAD and expected index tree;
- push checks `expectedLocalSha`, optional expected remote SHA, snapshots remote state, never force pushes, and reconciles ambiguous outcome by querying the remote;
- deterministic stale-state errors use `GIT_HEAD_MISMATCH`, `GIT_INDEX_CHANGED`, `GIT_REMOTE_CHANGED` before mutation.

- [ ] **Step 3: Run RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/git-repository-service.test.ts
```
Expected: FAIL because service does not exist.

- [ ] **Step 4: Implement minimal hardened Git service**

Allowed internal argv templates only:

```text
git rev-parse HEAD
git rev-parse --verify <ref>
git check-ref-format --branch <branch>
git switch -c <branch> <expectedHeadSha>
git add -- <validated paths...>
git write-tree
git diff --cached --quiet
git commit -m <message>
git rev-parse HEAD
git ls-remote --heads <remote> <branch>
git push <remote> <localSha>:refs/heads/<branch>
git remote get-url origin
```

Do not expose a general `run(args)` public method. A private/test-seamed `runGitChecked(cwd, fixedArgv)` may exist only inside the service module and must still use the hardened executable/env/process runner.

- [ ] **Step 5: Run GREEN + agent typecheck**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/git-repository-service.test.ts
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```
Expected: exit 0.

- [ ] **Step 6: Static security review**

Search Task 4 delta for `execSync`, `spawnSync`, `shell: true`, `--force`, `--force-with-lease`, `reset`, `rebase`, raw `process.env` pass-through and caller-provided Git config. Any finding in production code blocks the commit.

- [ ] **Step 7: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add services/workspace-agent/src/source-control/git-repository-service.ts services/workspace-agent/test/unit/source-control/git-repository-service.test.ts
# Add test/support/helpers.ts only if this Task changed it and review that hunk separately.
git commit -m "feat(agent): add typed git repository service"
```
---

### Task 5: GitHub credential provider, fixed HTTP client and typed GitHub service

**Files:**
- Modify: `packages/mcp-core/src/errors.ts`
- Create: `services/workspace-agent/src/source-control/github-credential-provider.ts`
- Create: `services/workspace-agent/src/source-control/gh-cli-user-credential-provider.ts`
- Create: `services/workspace-agent/src/source-control/github-http-client.ts`
- Create: `services/workspace-agent/src/source-control/github-service.ts`
- Test: `services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts`
- Test: `services/workspace-agent/test/unit/source-control/github-service.test.ts`

**Interfaces:**
- Consumes: `GitHubExecutor`, GitHub contracts and sanitized `AppError` surface from Task 1.
- Produces: `GitHubCredentialProvider`, `GhCliUserCredentialProvider`, `GitHubHttpClient`, `GitHubService` used by Task 6.

```ts
export interface GitHubCredential {
  readonly token: string;
  readonly source: "gh-cli-user" | "github-app-installation" | "account-provisioning";
}

export interface GitHubCredentialProvider {
  getCredential(context?: OperationContext): Promise<GitHubCredential>;
}
```

The credential object is private to the service boundary. Public MCP/result/audit schemas never import or serialize it.

- [ ] **Step 1: Write provider RED tests**

Inject a fake `gh` process runner. Assert the only accepted argv is exactly:

```text
gh auth token
```

Reject/never construct `gh api`, `gh repo`, arbitrary caller args or shell command strings. Assert `shell:false`, sanitized errors and that a fake token value never appears in thrown messages/causes/loggable return values.

- [ ] **Step 2: Write GitHubService RED tests**

Inject fake credential provider + fake fetch transport and verify fixed request mapping:

```text
GET  /user                               (resolve authenticated user login for account routing)
GET  /repos/{owner}/{repo}
POST /user/repos                         (user-owned creation when authenticated owner matches)
POST /orgs/{owner}/repos                 (organization-owned creation)
GET  /repos/{owner}/{repo}/pulls/{number}
POST /repos/{owner}/{repo}/pulls
PUT  /repos/{owner}/{repo}/pulls/{number}/merge
```

`GitHubHttpClient` fixes base URL `https://api.github.com`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, User-Agent owned by the application, and injects `Authorization: Bearer <opaque token>` internally.

Test that input cannot supply URL/path/header/method. Test strict JSON parsing and sanitized failures: credential, raw response body, raw fetch exception, raw `gh` stderr and raw JSON parse text must not survive in `AppError.message` or `cause`.

- [ ] **Step 3: Write reconciliation/TOCTOU RED tests**

Prove:
- repository create timeout/ambiguous response reconciles with `GET /repos/{owner}/{name}` before deciding success vs `SOURCE_CONTROL_RECONCILIATION_REQUIRED`;
- PR create ambiguous response reconciles by querying matching open PRs/head/base with an internally fixed endpoint/query builder;
- merge first reads PR, verifies `head.sha === expectedPullRequestHeadSha`, then sends that expected SHA in the merge request body;
- merge ambiguous response re-reads PR state/merge SHA before deciding;
- deterministic 4xx validation/auth errors are not blindly retried.

Representative merge body:

```ts
expect(request.body).toEqual({
  sha: expectedPullRequestHeadSha,
  merge_method: "squash",
});
```

- [ ] **Step 4: Run RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts services/workspace-agent/test/unit/source-control/github-service.test.ts
```
Expected: FAIL before the provider/client/service exist.

- [ ] **Step 5: Implement provider/client/service**

Keep HTTP endpoint construction private and typed. `GitHubService` implements exactly the five `GitHubExecutor` methods and validates every public result with Task 1 schemas before returning. Do not add a generic request method to the public executor.

Use existing `AUTHENTICATION_FAILED`, `INVALID_ARGUMENT`, and `SOURCE_CONTROL_RECONCILIATION_REQUIRED` where appropriate; add a new error code only if a test proves that none of the existing typed categories can represent a sanitized deterministic failure.

- [ ] **Step 6: Run GREEN + Agent regression/typecheck**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts services/workspace-agent/test/unit/source-control/github-service.test.ts
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
```
Expected: exit 0.

- [ ] **Step 7: Secret/redaction gate**

Run Gitleaks over the seven Task 5 paths. Search production delta for `gh api`, arbitrary URL concatenation from caller input, `console.*` of credential/headers, `process.env.GITHUB_TOKEN`, `process.env.GH_TOKEN`, and raw response/error inclusion in `cause`.

- [ ] **Step 8: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add packages/mcp-core/src/errors.ts services/workspace-agent/src/source-control/github-credential-provider.ts services/workspace-agent/src/source-control/gh-cli-user-credential-provider.ts services/workspace-agent/src/source-control/github-http-client.ts services/workspace-agent/src/source-control/github-service.ts services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts services/workspace-agent/test/unit/source-control/github-service.test.ts
git commit -m "feat(agent): add typed github api service"
```

---

### Task 6: LocalAgent policy/confirmation/idempotency integration and strict relay routing

**Files:**
- Modify: `packages/mcp-core/src/contracts.ts`
- Modify: `packages/mcp-core/src/audit.ts`
- Modify: `packages/mcp-core/src/source-control-policy.ts`
- Modify: `packages/mcp-core/src/mcp-workspace-tools.ts`
- Modify: `services/workspace-agent/src/internal-types.ts`
- Modify: `services/workspace-agent/src/workspace-registry.ts`
- Modify: `services/workspace-agent/src/local-agent.ts`
- Modify: `services/workspace-agent/src/connection/request-dispatcher.ts`
- Modify: `services/workspace-agent/src/connection/request-executor.ts`
- Modify: `services/workspace-agent/src/connection/service.ts`
- Modify: `services/workspace-agent/src/in-process-workspace-executor.ts`
- Modify: `services/workspace-agent/src/subprocess-workspace-executor.ts`
- Modify: `services/mcp-gateway/src/relay/workspace-executor.ts`
- Modify: `services/mcp-gateway/src/relay/request-manager.ts`
- Test: `services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts`
- Test: `services/workspace-agent/test/unit/connection/request-dispatcher.test.ts`
- Test: `services/workspace-agent/test/unit/connection/request-executor.test.ts`
- Test: `services/workspace-agent/test/e2e/agent-connection.test.ts`
- Test: `services/mcp-gateway/test/unit/relay/source-control-workspace-executor.test.ts`
- Test: `services/mcp-gateway/test/unit/relay/request-manager.test.ts`
- Test: `services/mcp-gateway/test/integration/relay/service.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts/ports, Task 2 capability assertion, Task 3 confirmations/receipts, Task 4 Git service and Task 5 GitHub service.
- Produces: LocalAgent methods for all nine operations; strict internal relay operations; serializable source-control operation identity context. Public MCP tool catalog remains unchanged until Task 7.

Internal relay operation mapping is exact:

```ts
const sourceControlRelayOperations = [
  "gitCreateBranch",
  "gitStagePaths",
  "gitCommit",
  "gitPushBranch",
  "githubGetRepository",
  "githubCreateRepository",
  "githubGetPullRequest",
  "githubCreatePullRequest",
  "githubMergePullRequest",
] as const;
```

- [ ] **Step 1: Write LocalAgent RED tests**

Create an Agent integration fixture with injectable fake `GitRepositoryExecutor`, `GitHubExecutor`, `TypedConfirmationRegistry`, `MutationReceiptStore`, and optional canonical repository resolver.

Required RED cases:

```ts
await expect(agent.getRepository({
  workspaceId: "repo",
  owner: "acme",
  repository: "app",
})).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
expect(githubCalls).toHaveLength(0);
```

Also prove:
- local branch/stage/commit execute without extra source-control confirmation when policy authorizes;
- push returns confirmation-required behavior on first call and executes only with exact confirmation binding;
- repository create and merge always require exact typed confirmation;
- PR create requires confirmation by default;
- changed args/target cannot reuse a grant;
- completed mutation replay with same identity does not call backend again and does not re-consume confirmation;
- same idempotency key + changed args throws `SOURCE_CONTROL_IDEMPOTENCY_CONFLICT` before backend;
- canonical GitHub repository resolves from real `origin` forms (`git@github.com:owner/repo.git`, `https://github.com/owner/repo.git`, `ssh://git@github.com/owner/repo.git`);
- non-GitHub/malformed/query-bearing origin fails closed unless target is explicitly `additionalRepositories`;
- repository creation authorizes `accountOwners`, not a nonexistent canonical repository.

- [ ] **Step 2: Run LocalAgent RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts
```
Expected: FAIL because LocalAgent source-control methods/wiring do not exist.

- [ ] **Step 3: Implement LocalAgent pipeline and safe audit metadata**

Add `LocalAgentOptions.sourceControl` dependency seams and defaults:

```ts
interface LocalAgentSourceControlOptions {
  gitRepository?: GitRepositoryExecutor;
  github?: GitHubExecutor;
  confirmations?: TypedConfirmationRegistry;
  receipts?: MutationReceiptStore;
  canonicalRepositoryResolver?: (workspaceRoot: string) => Promise<string | undefined>;
}
```

Each method performs, in order: parse -> resolve workspace/policy -> resolve typed target -> capability/target check -> completed replay/conflict check -> typed confirmation if required -> receipt reserve/executing -> one typed backend call -> result parse -> receipt complete -> sanitized audit.

For mutations without explicit `context.idempotencyKey`, derive an operation-stable key from confirmation id when present, otherwise `invocationId`, otherwise `correlationId`; if none exists, throw `INVALID_ARGUMENT`. Never derive it from credentials or random retry-local state.

Extend `AuditEntry` only with:

```ts
sourceControlCapability?: SourceControlCapability;
targetResource?: string;
expectedSha?: string;
resultSha?: string;
idempotencyOutcome?: "executed" | "completed_replay" | "confirmation_required";
```

- [ ] **Step 4: Write relay/hello/context RED tests**

Agent/Gateway tests must fail before relay production changes and prove:
- all nine operations are accepted by strict `relayRequestSchema` with exact inputs;
- unknown field such as `rawArgs` is rejected;
- `relayResultSchemas` rejects extra/sensitive fields;
- Gateway method -> exactly one camelCase relay call;
- Agent dispatcher -> exactly one LocalAgent method;
- hello advertises all operations from the authoritative relay schema, with no manual drift list;
- `correlationId`, `invocationId`, `idempotencyKey`, `ownerScope` cross Gateway -> Agent;
- `signal` is not serialized and deadline remains in the envelope.

- [ ] **Step 5: Implement strict relay contracts/routing**

Extend `relayOperationSchema`, discriminated `relayRequestSchema` and `relayResultSchemas` with the exact nine schemas. Validate the complete outgoing request in Gateway before JSON serialization.

Add a strict serializable `context` object to the relay request base containing only `correlationId`, `invocationId`, `idempotencyKey`, and `ownerScope`. Rebuild the Agent-side `OperationContext` from that object plus the envelope deadline and local cancellation `signal`; never place `signal` inside JSON.

In `mcp-workspace-tools.ts`, keep public catalog unchanged during Task 6 by typing existing public mapping as an exclusion of the nine source-control relay operations. Do not register source-control MCP names here yet.

`RelayWorkspaceExecutor` implements `WorkspaceExecutor`, `GitRepositoryExecutor`, and `GitHubExecutor`; every new method performs one `relay.call()` and parses one exact result schema.

Agent `connection/service.ts` derives hello capabilities from `relayOperationSchema.options` rather than a fixed list.

- [ ] **Step 6: Run focused GREEN**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts services/workspace-agent/test/unit/connection/request-dispatcher.test.ts services/workspace-agent/test/unit/connection/request-executor.test.ts services/workspace-agent/test/e2e/agent-connection.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/unit/relay/source-control-workspace-executor.test.ts services/mcp-gateway/test/unit/relay/request-manager.test.ts services/mcp-gateway/test/integration/relay/service.test.ts
```
Expected: exit 0.

- [ ] **Step 7: Run reconstructed source-control regression and type/build gates**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/typed-confirmation.test.ts packages/mcp-core/test/mutation-receipts.test.ts
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
npx tsc --noEmit -p services/mcp-gateway/tsconfig.json
npm run build --workspace @vs-code-gpt/shared
```

If package workspace names differ at the reconstructed HEAD, use the repository's existing direct `tsc -p ...` build commands rather than changing package identity just to satisfy this plan.

- [ ] **Step 8: Task 6 security gate**

Run `git diff --check`, BOM scan on Task 6 paths, Gitleaks on the Task 6 delta, and static search for raw `gh api`, `shell:true`, raw Authorization/token fields, generic relay execute operations, source-control public registration, force/reset/rebase/history rewrite.

- [ ] **Step 9: STOP for explicit commit authorization, then selectively stage and commit only if authorized**

`packages/mcp-core/src/mcp-workspace-tools.ts` and `services/workspace-agent/src/local-agent.ts` historically overlapped other work in the lost scratch. In the durable reconstruction they should begin clean; nevertheless inspect their full diff and stage only Task 6 hunks if any unrelated change appears.

Commit subject:

```bash
git commit -m "feat(relay): route typed source control operations"
```

No push.

---

### Task 7: Register exactly nine first-class MCP tools and update catalog identity

**Files:**
- Modify: `packages/mcp-core/src/mcp-workspace-tools.ts`
- Modify: `packages/mcp-core/src/mcp-tool-catalog.ts`
- Test: `packages/mcp-core/test/mcp-workspace-tools.test.ts`
- Test: `packages/mcp-core/test/mcp-tool-catalog.test.ts`
- Modify: `services/mcp-gateway/src/mcp/server.ts`
- Modify: `services/mcp-gateway/src/app.ts`
- Modify: `services/mcp-gateway/test/support/helpers.ts` only for the typed source-control fake required by MCP tests.
- Test: `services/mcp-gateway/test/integration/mcp/tools-list.test.ts`
- Test: `services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts`
- Test: `services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts`

**Interfaces:**
- Consumes: Task 1 source-control ports/contracts and Task 6 `RelayWorkspaceExecutor` implementing both source-control ports.
- Produces: public nine-tool MCP registration and recalculated catalog metadata. Keeps `WorkspaceExecutor` separate from source-control authorization/execution.

`McpServerOptions` becomes:

```ts
export interface McpServerOptions {
  workspaceExecutor: WorkspaceExecutor;
  sourceControlExecutor: GitRepositoryExecutor & GitHubExecutor;
  browser?: BrowserExecutor;
  auth?: McpServerAuthOptions;
  operationContextFactory?: ToolOperationContextFactory;
}
```

In production Gateway, pass the same Task 6 `RelayWorkspaceExecutor` instance as both `workspaceExecutor` and `sourceControlExecutor`; this is structural implementation reuse, not interface fusion.

- [ ] **Step 1: Write MCP registration RED tests**

Add the nine exact names to expected catalog assertions and create fake source-control executor spies. For each tool, invoke through MCP registration and prove it calls exactly one corresponding typed method with parsed input and operation context.

Tool annotations:

| Tool | readOnly | destructive | idempotent |
| --- | --- | --- | --- |
| `git_create_branch` | false | false | false |
| `git_stage_paths` | false | false | true |
| `git_commit` | false | false | false |
| `git_push_branch` | false | true | true |
| `github_get_repository` | true | false | true |
| `github_create_repository` | false | true | true |
| `github_get_pull_request` | true | false | true |
| `github_create_pull_request` | false | true | true |
| `github_merge_pull_request` | false | true | true |

`destructiveHint` here means externally impactful/high-impact, not that force/history rewrite is permitted.

- [ ] **Step 2: Run RED**

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/mcp-workspace-tools.test.ts packages/mcp-core/test/mcp-tool-catalog.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/integration/mcp/tools-list.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts
```
Expected: FAIL because the nine tools/catalog entries are not registered.

- [ ] **Step 3: Implement public registration without merging ports**

Add the nine names to `WorkspaceToolName`/`WORKSPACE_TOOL_NAMES`. Extend `RegisterWorkspaceToolsOptions` with required `sourceControlExecutor`. Each handler uses `withToolOperationContext`, validates its exact input/output schema, and calls only the corresponding source-control executor method.

Update `relayOperationToToolName` so the nine internal Task 6 operations map to the nine public names now that public registration exists.

Update Gateway `createMcpServer()` and app construction to provide the source-control executor separately. Recalculate catalog metadata through existing `createMcpToolCatalogMetadata`; do not hard-code a hash/version string.

- [ ] **Step 4: GREEN + catalog regression**

Run the commands from Step 2 plus:

```bash
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/mcp-gateway/tsconfig.json
```
Expected: exit 0 and tool count increases by exactly nine, with no extra source-control names.

- [ ] **Step 5: Verify authentication/context invariants**

Existing OAuth/noauth metadata must remain unchanged for old tools. New source-control tools receive the same MCP authentication gate and `OperationContext` factory; no credential or confirmation token is placed in tool descriptions, catalog metadata or diagnostic text.

- [ ] **Step 6: STOP for explicit commit authorization, then commit only if authorized**

```bash
git add packages/mcp-core/src/mcp-workspace-tools.ts packages/mcp-core/src/mcp-tool-catalog.ts packages/mcp-core/test/mcp-workspace-tools.test.ts packages/mcp-core/test/mcp-tool-catalog.test.ts services/mcp-gateway/src/mcp/server.ts services/mcp-gateway/src/app.ts services/mcp-gateway/test/integration/mcp/tools-list.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts
# Stage services/mcp-gateway/test/support/helpers.ts only if changed and after hunk review.
git commit -m "feat(mcp): register typed source control tools"
```

---

### Task 8: NEW reconstructed final end-to-end and security hardening gate

**Provenance:** This Task's exact historical text was not recovered. This is a newly specified final gate derived from the approved spec acceptance criteria and the known architecture; do not describe it as verbatim historical recovery.

**Files:**
- Create: `packages/mcp-core/test/source-control-public-boundary.test.ts`
- Create: `services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts`
- Modify production files only if a RED test exposes a concrete defect; any such production change must stay narrowly inside the source-control boundary and receive its own RED/GREEN evidence.

**Interfaces:**
- Consumes: completed Tasks 1–7.
- Produces: durable executable invariants proving exact surface, no escape hatches, strict result redaction, confirmation/idempotency propagation, and repository-wide regression readiness.

- [ ] **Step 1: Write exact public-boundary invariant test**

Test programmatically that the public source-control names equal exactly this set and nothing else:

```ts
expect(publicSourceControlNames.sort()).toEqual([
  "git_commit",
  "git_create_branch",
  "git_push_branch",
  "git_stage_paths",
  "github_create_pull_request",
  "github_create_repository",
  "github_get_pull_request",
  "github_get_repository",
  "github_merge_pull_request",
].sort());
```

Recursively inspect the nine input schema JSON shapes/parse behavior and assert forbidden keys (`command`, `args`, `argv`, `force`, `forceWithLease`, `url`, `headers`, `authorization`, `token`) are rejected everywhere they are not explicit safe domain fields. Assert exact nine capabilities too.

- [ ] **Step 2: Write MCP integration boundary test**

Use `createMcpServer` with fake workspace + source-control executors and invoke all nine tools. Prove:
- exact input reaches exactly one typed method;
- exact result returns in structured content;
- extra backend field such as `authorization`, `token`, `rawResponse`, or `stderr` is rejected by result parsing and never emitted;
- `OperationContext` has correlation/invocation/owner/deadline fields;
- confirmed mutation inputs may carry only opaque `confirmationId`, never credentials;
- read tools are non-mutating and mutation tools do not call shell executor methods.

- [ ] **Step 3: Run Task 8 RED/GREEN cycle**

First run the new tests before any Task 8 production correction. If both are already GREEN, record that no production correction was required; do not manufacture a code change merely to force RED. If a test exposes an unmet spec requirement, capture RED, implement the minimal correction, rerun GREEN.

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-public-boundary.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts
```

- [ ] **Step 4: Run complete reconstructed source-control regression**

Run all files matching the reconstructed boundary explicitly so unrelated repository tests cannot hide a skipped suite:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config packages/mcp-core/jest.config.ts --runInBand --runTestsByPath packages/mcp-core/test/source-control-contracts.test.ts packages/mcp-core/test/source-control-executor.test.ts packages/mcp-core/test/source-control-policy.test.ts packages/mcp-core/test/typed-confirmation.test.ts packages/mcp-core/test/mutation-receipts.test.ts packages/mcp-core/test/source-control-public-boundary.test.ts packages/mcp-core/test/mcp-workspace-tools.test.ts packages/mcp-core/test/mcp-tool-catalog.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/workspace-agent/jest.config.ts --runInBand --runTestsByPath services/workspace-agent/test/unit/source-control/file-mutation-receipt-store.test.ts services/workspace-agent/test/unit/source-control/git-repository-service.test.ts services/workspace-agent/test/unit/source-control/gh-cli-user-credential-provider.test.ts services/workspace-agent/test/unit/source-control/github-service.test.ts services/workspace-agent/test/integration/source-control/local-agent-source-control.test.ts services/workspace-agent/test/unit/connection/request-dispatcher.test.ts services/workspace-agent/test/unit/connection/request-executor.test.ts services/workspace-agent/test/e2e/agent-connection.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js --config services/mcp-gateway/jest.config.ts --runInBand --runTestsByPath services/mcp-gateway/test/unit/relay/source-control-workspace-executor.test.ts services/mcp-gateway/test/unit/relay/request-manager.test.ts services/mcp-gateway/test/integration/relay/service.test.ts services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts services/mcp-gateway/test/integration/mcp/tools-list.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync.test.ts services/mcp-gateway/test/integration/mcp/catalog-sync-http.test.ts
```

- [ ] **Step 5: Run fresh typecheck/build gates**

```bash
npx tsc --noEmit -p packages/mcp-core/tsconfig.json
npx tsc --noEmit -p services/workspace-agent/tsconfig.json
npx tsc --noEmit -p services/mcp-gateway/tsconfig.json
npm run build
```
Expected: all exit 0. If `npm run build` exceeds synchronous V3 execution, run it as a persisted background task and read final state/logs before claiming PASS.

- [ ] **Step 6: Run repository-wide regression as a heavy persisted gate**

Run:

```bash
npm run check
```

Prefer V3 background execution. Record task id, final exit code, failing suite if any, and do not substitute partial output for PASS.

- [ ] **Step 7: Final static/security verification**

Required:
- `git diff --check` over the entire reconstructed branch delta;
- UTF-8 BOM scan for all new/modified source-control files;
- Gitleaks/secret scan over the reconstructed delta;
- static search in production delta for `gh api`, `execSync`, `spawnSync`, `shell: true`, force push/history rewrite, raw `GITHUB_TOKEN`/`GH_TOKEN`, caller-provided URL/header/argv/config, and generic source-control execute operations;
- confirm no credential/Authorization values in fixtures, audit, receipt or MCP result schemas;
- confirm public source-control tools count = 9 and capabilities count = 9;
- confirm working tree/staging partition contains no unrelated operational `.ps1` changes because the durable boundary started from a clean independent base.

- [ ] **Step 8: Revalidate protected operational checkout**

From the operational workspace, verify branch/HEAD, staged count, non-PS1 count, and Authenticode status of the 19 preexisting PowerShell modifications. Any unexpected write outside ignored `.codex` is a blocker.

- [ ] **Step 9: STOP for explicit Task 8 commit authorization**

If Task 8 added only the two invariant tests:

```bash
git add packages/mcp-core/test/source-control-public-boundary.test.ts services/mcp-gateway/test/integration/mcp/source-control-tools.test.ts
git commit -m "test(source-control): harden typed source control boundary"
```

If Task 8 required a production correction, list the exact extra files and RED/GREEN evidence before asking authorization; never silently include them in the test commit.

No push follows this commit without a separate explicit gate.

---

## Implementation Execution Protocol

Before Task 1 implementation begins:

1. Verify branch `recovery/typed-source-control` and HEAD expected from the documentation gate.
2. Verify the only current untracked documentation files are the reconstituted spec and this plan; staged count must be zero.
3. Install dependencies in the durable clone using the lockfile-compatible repository command (`npm ci`) if `node_modules` is absent. Dependency installation must not modify lockfiles.
4. Run a focused baseline typecheck for `mcp-core`, `workspace-agent`, and `mcp-gateway`. If the historical base itself fails before source-control changes, record the failure and investigate instead of attributing it to Task 1.
5. Because spec/plan are currently untracked, request an explicit documentation commit gate before Task 1. Recommended documentation commit after approval:

```bash
git add mcp-access-stack/docs/superpowers/specs/2026-08-26-typed-source-control-github-design.md mcp-access-stack/docs/superpowers/plans/2026-08-26-typed-source-control-github.md
git commit -m "docs(source-control): restore typed GitHub design"
```

The Git root is the boundary parent, so paths in this documentation-only commit are Git-root-relative as shown above. Task implementation commands in Tasks 1–8 assume `cwd=mcp-access-stack`.

## Final Completion Criteria

The reconstruction is not complete until:

- reconstituted spec and plan have explicit approval and durable Git commits;
- Tasks 1–8 have fresh review gates and authorized commits;
- all nine tools/capabilities exist and no additional generic source-control surface exists;
- policy, confirmation, idempotency/reconciliation, Git process isolation, GitHub credential isolation, relay strictness, MCP catalog and audit redaction are proven by tests;
- full source-control regression, typechecks/builds, repository `npm run check`, diff/BOM/static/secret gates are fresh and green;
- protected operational checkout remains unchanged outside `.codex`;
- no push/deploy/cutover has occurred without its own explicit authorization.

## Execution Handoff

After this plan is approved, the next authorized action should be limited to the documentation commit gate above and Task 1 RED preflight. Use `superpowers:executing-plans` for inline execution in this same agent context, preserving a review/authorization checkpoint after each Task. Do not use a temporary clone and do not begin Task 2 automatically after a Task 1 commit unless the user has explicitly authorized that next gate.