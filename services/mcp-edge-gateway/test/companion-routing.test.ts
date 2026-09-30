import { describe, expect, it } from "@jest/globals";
import {
  isCompanionEligibleForUser,
  retireReplacedCompanion,
  selectAvailableCompanionWorkspaceId,
  selectAvailableRuntimeWorkspaceId,
  selectCompanionDevice,
  selectWorkspaceRuntime,
} from "../src/control-plane/companion-routing.js";

const candidates = [
  {
    target: "socket-a",
    deviceId: "dev-a",
    workspaceIds: ["repo-a", "shared"],
  },
  {
    target: "socket-b",
    deviceId: "dev-b",
    workspaceIds: ["repo-b"],
  },
];

describe("companion routing", () => {
  it("filters companion eligibility by online state, readiness, user and optional device", () => {
    const base = {
      online: true,
      ready: true,
      userId: "usr-a",
      deviceId: "dev-a",
    };

    expect(isCompanionEligibleForUser(base, "usr-a")).toBe(true);
    expect(isCompanionEligibleForUser(base, "usr-a", "dev-a")).toBe(true);
    expect(isCompanionEligibleForUser(base, "usr-b")).toBe(false);
    expect(isCompanionEligibleForUser(base, "usr-a", "dev-b")).toBe(false);
    expect(isCompanionEligibleForUser({ ...base, online: false }, "usr-a")).toBe(false);
    expect(isCompanionEligibleForUser({ ...base, ready: false }, "usr-a")).toBe(false);
    expect(isCompanionEligibleForUser({ ...base, deviceId: undefined }, "usr-a")).toBe(false);
  });

  it("makes a replaced companion immediately ineligible before socket close completes", () => {
    const active = {
      online: true,
      ready: true,
      userId: "usr-a",
      deviceId: "dev-a",
      capabilities: ["browser"],
    };
    const retired = retireReplacedCompanion(active);

    expect(retired).toEqual({
      ...active,
      ready: false,
    });
    expect(isCompanionEligibleForUser(retired, "usr-a", "dev-a")).toBe(false);
    expect(isCompanionEligibleForUser(active, "usr-a", "dev-a")).toBe(true);
  });

  it("keeps one eligible owner throughout same-device handover", () => {
    const oldAttachment = {
      online: true,
      ready: true,
      userId: "usr-a",
      deviceId: "dev-a",
    };
    const pendingNewAttachment = {
      online: true,
      ready: false,
      userId: "usr-a",
      deviceId: "dev-a",
    };

    const beforeReady = [oldAttachment, pendingNewAttachment]
      .filter((attachment) => isCompanionEligibleForUser(attachment, "usr-a", "dev-a"))
      .map((attachment, index) => ({
        target: index === 0 ? "old" : "new",
        deviceId: attachment.deviceId!,
        workspaceIds: ["repo-a"],
      }));
    expect(selectCompanionDevice(beforeReady, "dev-a")).toMatchObject({
      kind: "selected",
      candidate: { target: "old" },
    });

    const afterReady = [retireReplacedCompanion(oldAttachment), { ...pendingNewAttachment, ready: true }]
      .filter((attachment) => isCompanionEligibleForUser(attachment, "usr-a", "dev-a"))
      .map((attachment) => ({
        target: attachment.ready && attachment === oldAttachment ? "old" : "new",
        deviceId: attachment.deviceId!,
        workspaceIds: ["repo-a"],
      }));
    expect(afterReady).toHaveLength(1);
    expect(selectCompanionDevice(afterReady, "dev-a")).toMatchObject({
      kind: "selected",
      candidate: { target: "new" },
    });
  });

  it("requires device selection only when more than one eligible device exists", () => {
    expect(selectCompanionDevice(candidates)).toEqual({ kind: "ambiguous" });
    expect(selectCompanionDevice(candidates, "dev-a")).toEqual({
      kind: "selected",
      candidate: candidates[0],
    });
    expect(selectCompanionDevice(candidates, "missing")).toEqual({ kind: "none" });
  });

  it("keeps a companion workspace id when it does not collide", () => {
    expect(selectAvailableCompanionWorkspaceId(
      "mcp-access-stack",
      "c:/users/rafael/project/mcp-access-stack",
      new Set(["primary-only"]),
    )).toBe("mcp-access-stack");
  });

  it("deterministically disambiguates companion workspace ids reserved by another runtime", () => {
    const reserved = new Set(["mcp-access-stack"]);
    const first = selectAvailableCompanionWorkspaceId(
      "mcp-access-stack",
      "c:/users/rafael/project/mcp-access-stack",
      reserved,
    );
    const second = selectAvailableCompanionWorkspaceId(
      "mcp-access-stack",
      "c:/users/rafael/project/mcp-access-stack",
      reserved,
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^mcp-access-stack-local-[a-f0-9]{8}$/u);
    expect(reserved.has(first)).toBe(false);
  });

  it("advances deterministically when the first disambiguated id is also reserved", () => {
    const first = selectAvailableCompanionWorkspaceId(
      "repo-a",
      "c:/repos/repo-a",
      new Set(["repo-a"]),
    );
    const second = selectAvailableCompanionWorkspaceId(
      "repo-a",
      "c:/repos/repo-a",
      new Set(["repo-a", first]),
    );

    expect(second).toBe(`${first}-2`);
  });

  it("uses a remote-specific deterministic suffix without changing companion ids", () => {
    const reserved = new Set(["mcp-access-stack"]);
    const remote = selectAvailableRuntimeWorkspaceId(
      "mcp-access-stack",
      "rt_primary:repo-a",
      reserved,
      "remote",
    );
    const companion = selectAvailableCompanionWorkspaceId(
      "mcp-access-stack",
      "c:/repos/mcp-access-stack",
      reserved,
    );

    expect(remote).toMatch(/^mcp-access-stack-remote-[a-f0-9]{8}$/u);
    expect(companion).toMatch(/^mcp-access-stack-local-[a-f0-9]{8}$/u);
  });

  it("routes a workspace to one companion when primary does not own it", () => {
    expect(selectWorkspaceRuntime(
      candidates,
      "repo-a",
      new Set(["primary-only"]),
    )).toEqual({
      kind: "companion",
      candidate: candidates[0],
    });
  });

  it("fails closed on primary/companion or multi-companion collisions", () => {
    expect(selectWorkspaceRuntime(
      candidates,
      "repo-a",
      new Set(["repo-a"]),
    )).toEqual({ kind: "collision" });

    expect(selectWorkspaceRuntime(
      [
        ...candidates,
        { target: "socket-c", deviceId: "dev-c", workspaceIds: ["repo-a"] },
      ],
      "repo-a",
      new Set(),
    )).toEqual({ kind: "collision" });
  });

  it("preserves primary and unresolved routing semantics", () => {
    expect(selectWorkspaceRuntime(
      candidates,
      "primary-only",
      new Set(["primary-only"]),
    )).toEqual({ kind: "primary" });
    expect(selectWorkspaceRuntime(
      candidates,
      "missing",
      new Set(["primary-only"]),
    )).toEqual({ kind: "none" });
  });
});
