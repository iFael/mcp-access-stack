import { describe, expect, test } from "@jest/globals";
import type { RelayOperation } from "../src/contracts.js";
import {
  RETRYABLE_RELAY_OPERATIONS,
  isRetryableRelayOperation,
} from "../src/relay-retry-policy.js";

const retryable: RelayOperation[] = [
  "listWorkspaces",
  "listWorkspaceRoots",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "runValidation",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "getBackgroundTask",
  "waitBackgroundTask",
  "listBackgroundTasks",
  "readBackgroundTaskLogs",
  "githubGetRepository",
  "githubGetPullRequest",
];

const mutatingOrAmbiguous: RelayOperation[] = [
  "writeFile",
  "patchFile",
  "runCommand",
  "runPowerShell",
  "startBackgroundTask",
  "cancelBackgroundTask",
  "gitCreateBranch",
  "gitStagePaths",
  "gitUnstagePaths",
  "gitCommit",
  "gitMergeBranch",
  "gitPushBranch",
  "githubCreateRepository",
  "githubCreatePullRequest",
  "githubMergePullRequest",
];

describe("relay retry policy", () => {
  test("contains only operations that are formally read-only and idempotent", () => {
    expect([...RETRYABLE_RELAY_OPERATIONS]).toEqual(retryable);

    for (const operation of retryable) {
      expect(isRetryableRelayOperation(operation)).toBe(true);
    }
  });

  test("never classifies mutating or outcome-ambiguous operations as retryable", () => {
    for (const operation of mutatingOrAmbiguous) {
      expect(isRetryableRelayOperation(operation)).toBe(false);
    }
  });
});
