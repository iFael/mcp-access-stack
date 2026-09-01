import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalSourceControlArgumentsDigest,
  type MutationReceiptIdentity,
} from "@vs-code-gpt/shared";
import {
  FileMutationReceiptStore,
  type MutationReceiptFileOperations,
} from "../../../src/source-control/file-mutation-receipt-store.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "mcp-receipts-"));
});

afterEach(async () => {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function identity(
  overrides: Partial<MutationReceiptIdentity> = {},
): MutationReceiptIdentity {
  return {
    workspaceId: "repo",
    operation: "git_push_branch",
    targetResource: "origin/feature/task3",
    canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest({
      branch: "feature/task3",
      expectedLocalSha: "a".repeat(40),
    }),
    idempotencyKey: "persistent-task3-key",
    ...overrides,
  };
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

describe("FileMutationReceiptStore", () => {
  it("persists receipts under runtime-private and reloads completed replay", async () => {
    const store = new FileMutationReceiptStore(workspaceRoot);
    const expected = identity();

    await store.reserve(expected);
    await store.markExecuting(expected);
    await store.markCompleted(expected, {
      remote: "origin",
      branch: "feature/task3",
      localSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
    });

    const receiptDirectory = path.join(
      workspaceRoot,
      ".runtime-private",
      "source-control-receipts",
    );
    const entries = await readdir(receiptDirectory);
    expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    expect(entries.some((entry) => entry.includes(".tmp"))).toBe(false);

    const reloaded = new FileMutationReceiptStore(workspaceRoot);
    const replay = await reloaded.reserve(expected);
    expect(replay).toMatchObject({
      disposition: "replay_completed",
      receipt: {
        state: "completed",
        result: {
          branch: "feature/task3",
          remoteSha: "a".repeat(40),
        },
      },
    });
  });

  it("writes through a same-directory temporary file and atomic rename", async () => {
    const events: Array<{ kind: "write" | "rename"; from: string; to?: string }> = [];
    const operations: MutationReceiptFileOperations = {
      ensureDirectory: async (directory) => {
        await mkdir(directory, { recursive: true });
      },
      readText: readTextOrUndefined,
      writeText: async (filePath, content) => {
        events.push({ kind: "write", from: filePath });
        await writeFile(filePath, content, "utf8");
      },
      rename: async (from, to) => {
        events.push({ kind: "rename", from, to });
        await rename(from, to);
      },
      remove: async (filePath) => {
        await rm(filePath, { force: true });
      },
    };
    const store = new FileMutationReceiptStore(workspaceRoot, { fileOperations: operations });

    await store.reserve(identity());

    const writeEvent = events.find((event) => event.kind === "write");
    const renameEvent = events.find((event) => event.kind === "rename");
    expect(writeEvent).toBeDefined();
    expect(renameEvent).toBeDefined();
    expect(path.dirname(writeEvent!.from)).toBe(path.dirname(renameEvent!.to!));
    expect(writeEvent!.from).toMatch(/\.tmp-/u);
    expect(renameEvent!.from).toBe(writeEvent!.from);
    expect(renameEvent!.to).toMatch(/\.json$/u);
  });

  it("serializes concurrent reservations for the same idempotency key", async () => {
    const store = new FileMutationReceiptStore(workspaceRoot);
    const expected = identity();

    const reservations = await Promise.all([
      store.reserve(expected),
      store.reserve(expected),
    ]);

    expect(reservations.map((entry) => entry.disposition).sort()).toEqual([
      "execute",
      "reconciliation_required",
    ]);
  });

  it("never persists confirmation ids or credential-like completed results", async () => {
    const store = new FileMutationReceiptStore(workspaceRoot);
    const expected = identity();
    await store.reserve(expected);
    await store.markExecuting(expected);

    await expect(
      store.markCompleted(expected, {
        confirmationId: "opaque-grant",
        token: "top-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await store.markCompleted(expected, {
      remote: "origin",
      branch: "feature/task3",
      localSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
    });

    const receiptDirectory = path.join(
      workspaceRoot,
      ".runtime-private",
      "source-control-receipts",
    );
    const [fileName] = (await readdir(receiptDirectory)).filter((entry) =>
      entry.endsWith(".json"),
    );
    const persisted = await readFile(path.join(receiptDirectory, fileName!), "utf8");
    expect(persisted).not.toContain("confirmationId");
    expect(persisted).not.toContain("opaque-grant");
    expect(persisted).not.toContain("top-secret");
    expect(persisted.toLowerCase()).not.toContain("authorization");
  });
});
