import { describe, expect, it } from "@jest/globals";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalAgentMcpUpdatePort, createLocalAgentReleasePort } from "../../../src/mcp-update/local-agent-port.js";
import type { LocalAgent } from "../../../src/local-agent.js";

const TAG = "v1.1.0-beta.149-connector.1";
const OLD_SHA = "9".repeat(40);

function portWithRefs(result: unknown, observed?: unknown[]) {
  const agent = { githubRead: async (input: unknown) => {
    observed?.push(input);
    if (result instanceof Error) throw result;
    return result;
  } } as unknown as LocalAgent;
  return createLocalAgentMcpUpdatePort(() => agent, { requestCompanionUpdate: () => undefined });
}

describe("native update tag reference preflight", () => {
  it("selects an exact immutable ref and ignores longer prefix matches", async () => {
    const requests: unknown[] = [];
    const port = portWithRefs({
      kind: "refs", page: 1,
      items: [
        { ref: "refs/tags/" + TAG + "0", sha: "a".repeat(40), type: "commit" },
        { ref: "refs/tags/" + TAG, sha: OLD_SHA, type: "commit" },
      ],
    }, requests);
    await expect(port.tagCommit(TAG)).resolves.toBe(OLD_SHA);
    expect(requests).toEqual([{
      workspaceId: "mcp-access-stack", owner: "iFael", repository: "mcp-access-stack",
      kind: "refs", refType: "tags", prefix: TAG, page: 1, perPage: 100,
    }]);
  });

  it("reports a truly absent tag, but not an incomplete inventory", async () => {
    await expect(portWithRefs({ kind: "refs", page: 1, items: [] }).tagCommit(TAG))
      .resolves.toBeNull();
    await expect(portWithRefs({ kind: "refs", page: 1, items: [], nextPage: 2 }).tagCommit(TAG))
      .rejects.toThrow();
  });

  it("fails closed on malformed refs or a GitHub read error", async () => {
    for (const items of [
      [{ ref: "refs/tags/" + TAG, type: "tag", sha: OLD_SHA }],
      [{ ref: "refs/tags/" + TAG, type: "commit", sha: "invalid" }],
      [
        { ref: "refs/tags/" + TAG, type: "commit", sha: OLD_SHA },
        { ref: "refs/tags/" + TAG, type: "commit", sha: OLD_SHA },
      ],
    ]) {
      await expect(portWithRefs({ kind: "refs", page: 1, items }).tagCommit(TAG))
        .rejects.toThrow();
    }
    await expect(portWithRefs(new Error("github-unavailable")).tagCommit(TAG))
      .rejects.toThrow("github-unavailable");
  });
});

describe("Oracle cutover broker terminal receipts", () => {
  it("follows the original handoff identity through unknown, passed and failed outcomes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mcp-cutover-status-"));
    const requestId = "00000000-0000-4000-8000-000000000321";
    const releaseId = "1.1.0-beta.151-connector.1";
    const resultPath = path.join(directory, "state", "linux-cutover-runs", requestId, "result.json");
    let installedRoot = directory;
    const agent = {
      getReleaseState: async () => ({ installationRoot: installedRoot, state: {} }),
      promoteRelease: async () => ({
        status: "handover_started", requestId, releaseId, resultPath, installationRoot: directory,
        brokerTaskName: "systemd-user:broker", projectRoot: directory,
      }),
    } as unknown as LocalAgent;
    const port = createLocalAgentReleasePort(() => agent, "mcp-access-stack");
    try {
      const started = await port.promote(releaseId);
      expect(started.status).toBe("handover_started");
      if (started.status !== "handover_started" || !started.cutoverReceipt || !port.cutoverStatus) {
        throw new Error("Oracle promotion did not retain its receipt identity.");
      }
      const receipt = started.cutoverReceipt;
      expect(receipt.requestId).toBe(requestId);
      await expect(port.cutoverStatus(receipt)).resolves.toBeNull();
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, requestId, releaseId, status: "passed" }));
      await expect(port.cutoverStatus(receipt)).resolves.toBe("passed");
      await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, requestId, releaseId, status: "failed" }));
      await expect(port.cutoverStatus(receipt)).resolves.toBe("failed");
      await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, requestId, releaseId, status: "unknown" }));
      await expect(port.cutoverStatus(receipt)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, requestId: "another", releaseId, status: "passed" }));
      await expect(port.cutoverStatus(receipt)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      await writeFile(resultPath, "not-json");
      await expect(port.cutoverStatus(receipt)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      await expect(port.cutoverStatus({ ...receipt, resultPath: path.join(directory, "another.json") }))
        .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      installedRoot = path.dirname(directory);
      await expect(port.cutoverStatus(receipt)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
