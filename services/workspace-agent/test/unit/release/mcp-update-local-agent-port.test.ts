import { describe, expect, it } from "@jest/globals";
import { createLocalAgentMcpUpdatePort } from "../../../src/mcp-update/local-agent-port.js";
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
