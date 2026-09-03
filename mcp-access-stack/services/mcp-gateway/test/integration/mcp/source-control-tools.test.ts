import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import type {
  OperationContext,
  SourceControlExecutor,
  WorkspaceExecutor,
} from "@vs-code-gpt/shared";
import { createMcpServer } from "../../../src/mcp/server.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);
const opaqueConfirmationId = "opaque-confirmation-id-task8";

interface ExecutorCall {
  method: string;
  input: Record<string, unknown>;
  context: OperationContext | undefined;
}

class RecordingSourceControlExecutor {
  calls: ExecutorCall[] = [];
  extraResultFields: Record<string, unknown> = {};

  private record(method: string, input: Record<string, unknown>, context?: OperationContext): void {
    this.calls.push({ method, input, context });
  }

  private result<T extends Record<string, unknown>>(value: T): T & Record<string, unknown> {
    return { ...value, ...this.extraResultFields };
  }

  async createBranch(input: any, context?: OperationContext) {
    this.record("createBranch", input, context);
    return this.result({ root: input.root ?? ".", branch: input.branch, headSha: input.expectedHeadSha });
  }

  async stagePaths(input: any, context?: OperationContext) {
    this.record("stagePaths", input, context);
    return this.result({ root: input.root ?? ".", headSha: shaA, indexTreeSha: shaB, paths: input.paths });
  }

  async unstagePaths(input: any, context?: OperationContext) {
    this.record("unstagePaths", input, context);
    return this.result({ root: input.root ?? ".", headSha: input.expectedHeadSha, indexTreeSha: shaC, paths: input.paths });
  }

  async commit(input: any, context?: OperationContext) {
    this.record("commit", input, context);
    return this.result({ root: input.root ?? ".", branch: "feature/task8", commitSha: shaC });
  }

  async mergeBranch(input: any, context?: OperationContext) {
    this.record("mergeBranch", input, context);
    return this.result({
      root: input.root ?? ".",
      branch: "feature/task8",
      previousHeadSha: input.expectedTargetHeadSha,
      headSha: input.expectedSourceHeadSha,
      sourceHeadSha: input.expectedSourceHeadSha,
      fastForwarded: true as const,
    });
  }

  async pushBranch(input: any, context?: OperationContext) {
    this.record("pushBranch", input, context);
    return this.result({
      status: "completed" as const,
      root: input.root ?? ".",
      remote: input.remote ?? "origin",
      branch: input.branch,
      localSha: input.expectedLocalSha,
      remoteSha: input.expectedLocalSha,
    });
  }

  async getRepository(input: any, context?: OperationContext) {
    this.record("getRepository", input, context);
    return this.result({
      owner: input.owner,
      name: input.repository,
      fullName: `${input.owner}/${input.repository}`,
      defaultBranch: "main",
      visibility: "private" as const,
      url: `https://github.com/${input.owner}/${input.repository}`,
    });
  }

  async createRepository(input: any, context?: OperationContext) {
    this.record("createRepository", input, context);
    return this.result({
      status: "completed" as const,
      owner: input.owner,
      name: input.name,
      fullName: `${input.owner}/${input.name}`,
      defaultBranch: "main",
      visibility: input.visibility,
      url: `https://github.com/${input.owner}/${input.name}`,
    });
  }

  async getPullRequest(input: any, context?: OperationContext) {
    this.record("getPullRequest", input, context);
    return this.result({
      number: input.pullNumber,
      state: "open" as const,
      title: "Task 8",
      url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullNumber}`,
      headSha: shaB,
      baseSha: shaA,
      merged: false,
    });
  }

  async createPullRequest(input: any, context?: OperationContext) {
    this.record("createPullRequest", input, context);
    return this.result({
      status: "completed" as const,
      number: 8,
      state: "open" as const,
      title: input.title,
      url: `https://github.com/${input.owner}/${input.repository}/pull/8`,
      headSha: shaB,
      baseSha: shaA,
      merged: false,
    });
  }

  async mergePullRequest(input: any, context?: OperationContext) {
    this.record("mergePullRequest", input, context);
    return this.result({
      status: "completed" as const,
      number: input.pullNumber,
      merged: true,
      mergeSha: shaC,
    });
  }
}

const cases = [
  {
    name: "git_create_branch",
    method: "createBranch",
    input: { workspaceId: "repo", root: "project", branch: "feature/task8", expectedHeadSha: shaA },
    expectedInput: { workspaceId: "repo", root: "project", branch: "feature/task8", expectedHeadSha: shaA },
    expectedResult: { root: "project", branch: "feature/task8", headSha: shaA },
  },
  {
    name: "git_stage_paths",
    method: "stagePaths",
    input: { workspaceId: "repo", root: "project", paths: ["src/a.ts"] },
    expectedInput: { workspaceId: "repo", root: "project", paths: ["src/a.ts"] },
    expectedResult: { root: "project", headSha: shaA, indexTreeSha: shaB, paths: ["src/a.ts"] },
  },
  {
    name: "git_unstage_paths",
    method: "unstagePaths",
    input: { workspaceId: "repo", root: "project", paths: ["src/a.ts"], expectedHeadSha: shaA, expectedIndexTreeSha: shaB },
    expectedInput: { workspaceId: "repo", root: "project", paths: ["src/a.ts"], expectedHeadSha: shaA, expectedIndexTreeSha: shaB },
    expectedResult: { root: "project", headSha: shaA, indexTreeSha: shaC, paths: ["src/a.ts"] },
  },
  {
    name: "git_commit",
    method: "commit",
    input: { workspaceId: "repo", root: "project", message: "Task 8", expectedHeadSha: shaA, expectedIndexTreeSha: shaB },
    expectedInput: { workspaceId: "repo", root: "project", message: "Task 8", expectedHeadSha: shaA, expectedIndexTreeSha: shaB },
    expectedResult: { root: "project", branch: "feature/task8", commitSha: shaC },
  },
  {
    name: "git_merge_branch",
    method: "mergeBranch",
    input: { workspaceId: "repo", root: "project", sourceBranch: "feature/source", expectedTargetHeadSha: shaA, expectedSourceHeadSha: shaB },
    expectedInput: { workspaceId: "repo", root: "project", sourceBranch: "feature/source", expectedTargetHeadSha: shaA, expectedSourceHeadSha: shaB },
    expectedResult: { root: "project", branch: "feature/task8", previousHeadSha: shaA, headSha: shaB, sourceHeadSha: shaB, fastForwarded: true },
  },
  {
    name: "git_push_branch",
    method: "pushBranch",
    input: { workspaceId: "repo", root: "project", branch: "feature/task8", expectedLocalSha: shaA, confirmationId: opaqueConfirmationId },
    expectedInput: { workspaceId: "repo", root: "project", branch: "feature/task8", expectedLocalSha: shaA, remote: "origin", confirmationId: opaqueConfirmationId },
    expectedResult: { status: "completed", root: "project", remote: "origin", branch: "feature/task8", localSha: shaA, remoteSha: shaA },
  },
  {
    name: "github_get_repository",
    method: "getRepository",
    input: { workspaceId: "repo", root: "project", owner: "octo", repository: "app" },
    expectedInput: { workspaceId: "repo", root: "project", owner: "octo", repository: "app" },
    expectedResult: { owner: "octo", name: "app", fullName: "octo/app", defaultBranch: "main", visibility: "private", url: "https://github.com/octo/app" },
  },
  {
    name: "github_create_repository",
    method: "createRepository",
    input: { workspaceId: "repo", owner: "octo", name: "app", visibility: "private", confirmationId: opaqueConfirmationId },
    expectedInput: { workspaceId: "repo", owner: "octo", name: "app", visibility: "private", confirmationId: opaqueConfirmationId },
    expectedResult: { status: "completed", owner: "octo", name: "app", fullName: "octo/app", defaultBranch: "main", visibility: "private", url: "https://github.com/octo/app" },
  },
  {
    name: "github_get_pull_request",
    method: "getPullRequest",
    input: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", pullNumber: 8 },
    expectedInput: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", pullNumber: 8 },
    expectedResult: { number: 8, state: "open", title: "Task 8", url: "https://github.com/octo/app/pull/8", headSha: shaB, baseSha: shaA, merged: false },
  },
  {
    name: "github_create_pull_request",
    method: "createPullRequest",
    input: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", title: "Task 8", head: "feature/task8", base: "main", confirmationId: opaqueConfirmationId },
    expectedInput: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", title: "Task 8", head: "feature/task8", base: "main", draft: false, confirmationId: opaqueConfirmationId },
    expectedResult: { status: "completed", number: 8, state: "open", title: "Task 8", url: "https://github.com/octo/app/pull/8", headSha: shaB, baseSha: shaA, merged: false },
  },
  {
    name: "github_merge_pull_request",
    method: "mergePullRequest",
    input: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", pullNumber: 8, expectedPullRequestHeadSha: shaB, mergeMethod: "squash", confirmationId: opaqueConfirmationId },
    expectedInput: { workspaceId: "repo", root: "project", owner: "octo", repository: "app", pullNumber: 8, expectedPullRequestHeadSha: shaB, mergeMethod: "squash", confirmationId: opaqueConfirmationId },
    expectedResult: { status: "completed", number: 8, merged: true, mergeSha: shaC },
  },
] as const;

const confirmableNames = new Set([
  "git_push_branch",
  "github_create_repository",
  "github_create_pull_request",
  "github_merge_pull_request",
]);

async function withConnectedServer(
  executor: RecordingSourceControlExecutor,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  let invocation = 0;
  const server = createMcpServer({
    workspaceExecutor: {} as WorkspaceExecutor,
    sourceControlExecutor: executor as unknown as SourceControlExecutor,
    operationContextFactory: (extra, requestedTimeoutMs) => ({
      context: {
        signal: extra.signal,
        correlationId: `corr-${String(extra.requestId)}`,
        invocationId: `inv-${++invocation}`,
        ownerScope: "owner:test",
        deadline: {
          requestedTimeoutMs,
          effectiveTimeoutMs: requestedTimeoutMs,
          deadlineAt: new Date(Date.now() + requestedTimeoutMs).toISOString(),
        },
      },
      release: () => undefined,
    }),
  });
  const client = new Client(
    { name: "source-control-boundary-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await run(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("MCP typed source-control boundary", () => {
  it.each(cases.filter((candidate) => confirmableNames.has(candidate.name)))(
    "accepts a valid completed result for confirmable tool $name",
    async (testCase) => {
      const executor = new RecordingSourceControlExecutor();
      await withConnectedServer(executor, async (client) => {
        const result = await client.callTool({ name: testCase.name, arguments: testCase.input });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(testCase.expectedResult);
      });
    },
  );
  it("routes each public tool once with parsed input, structured result and operation context", async () => {
    const executor = new RecordingSourceControlExecutor();

    await withConnectedServer(executor, async (client) => {
      for (const testCase of cases) {
        const before = executor.calls.length;
        const result = await client.callTool({
          name: testCase.name,
          arguments: testCase.input,
        });

        if (result.isError) {
          throw new Error(`${testCase.name}: ${JSON.stringify(result)}`);
        }
        expect(result.structuredContent).toEqual(testCase.expectedResult);
        expect(executor.calls).toHaveLength(before + 1);

        const call = executor.calls.at(-1)!;
        expect(call.method).toBe(testCase.method);
        expect(call.input).toEqual(testCase.expectedInput);
        expect(call.context).toMatchObject({
          correlationId: expect.stringMatching(/^corr-/u),
          invocationId: expect.stringMatching(/^inv-/u),
          ownerScope: "owner:test",
          deadline: {
            requestedTimeoutMs: expect.any(Number),
            effectiveTimeoutMs: expect.any(Number),
            deadlineAt: expect.any(String),
          },
        });
        expect(call.context?.signal).toBeInstanceOf(AbortSignal);

        if (confirmableNames.has(testCase.name)) {
          expect(call.input.confirmationId).toBe(opaqueConfirmationId);
          expect(JSON.stringify(call.input)).not.toMatch(/authorization|token|headers/iu);
        }
      }
    });
  });

  it("rejects credential-like caller fields before confirmable operations reach the executor", async () => {
    const executor = new RecordingSourceControlExecutor();

    await withConnectedServer(executor, async (client) => {
      for (const testCase of cases.filter((candidate) => confirmableNames.has(candidate.name))) {
        for (const forbiddenKey of ["authorization", "token", "headers"] as const) {
          const before = executor.calls.length;
          const result = await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.input, [forbiddenKey]: `caller-secret-${forbiddenKey}` },
          });

          expect(result.isError).toBe(true);
          expect(executor.calls).toHaveLength(before);
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain(`caller-secret-${forbiddenKey}`);
        }
      }
    });
  });

  it("rejects extra backend result fields for all eleven tools without emitting them", async () => {
    const executor = new RecordingSourceControlExecutor();
    const forbiddenResultFields = ["authorization", "token", "rawResponse", "stderr"] as const;

    await withConnectedServer(executor, async (client) => {
      for (const [index, testCase] of cases.entries()) {
        const forbiddenField = forbiddenResultFields[index % forbiddenResultFields.length]!;
        const sentinel = `backend-secret-${forbiddenField}-${index}`;
        executor.extraResultFields = { [forbiddenField]: sentinel };

        const result = await client.callTool({
          name: testCase.name,
          arguments: testCase.input,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(forbiddenField);
        expect(serialized).not.toContain(sentinel);
      }
    });
  });
});
