import { describe, expect, it } from "@jest/globals";
import {
  isCompanionEligibleForUser,
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

  it("requires device selection only when more than one eligible device exists", () => {
    expect(selectCompanionDevice(candidates)).toEqual({ kind: "ambiguous" });
    expect(selectCompanionDevice(candidates, "dev-a")).toEqual({
      kind: "selected",
      candidate: candidates[0],
    });
    expect(selectCompanionDevice(candidates, "missing")).toEqual({ kind: "none" });
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
