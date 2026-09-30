import { describe, expect, it } from "@jest/globals";
import {
  selectBrowserExecutionRoute,
  type BrowserRuntimeAffinity,
} from "../src/control-plane/browser-routing.js";

const runtimeId = "rt_11111111-1111-4111-8111-111111111111";
const epochA = "22222222-2222-4222-8222-222222222222";
const epochB = "33333333-3333-4333-8333-333333333333";
const deviceA = "dev_44444444-4444-4444-8444-444444444444";
const deviceB = "dev_55555555-5555-4555-8555-555555555555";
const remoteAffinity: BrowserRuntimeAffinity = {
  version: 3,
  runtimeId,
  browserEpoch: epochA,
};

describe("Browser runtime routing", () => {
  it("uses the primary runtime by default when no companion is available", () => {
    expect(selectBrowserExecutionRoute({
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [],
    })).toEqual({ kind: "primary-default" });
  });

  it("never falls back to remote when an affinity-owned companion is offline", () => {
    expect(selectBrowserExecutionRoute({
      affinityDeviceId: deviceA,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [],
    })).toMatchObject({
      kind: "error",
      code: "AGENT_UNAVAILABLE",
    });
  });

  it("allows explicit remote selection even while a companion is online", () => {
    expect(selectBrowserExecutionRoute({
      requestedRuntimeId: runtimeId,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [deviceA],
    })).toEqual({ kind: "remote" });
  });

  it("preserves a remote affinity when runtime and browser epoch still match", () => {
    expect(selectBrowserExecutionRoute({
      affinityRuntime: remoteAffinity,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [deviceA],
    })).toEqual({ kind: "remote" });
  });

  it("marks remote task/tab references stale after Browser recreation", () => {
    expect(selectBrowserExecutionRoute({
      affinityRuntime: remoteAffinity,
      remote: { runtimeId, online: true, browserEpoch: epochB },
      companionDeviceIds: [],
    })).toMatchObject({
      kind: "error",
      code: "BROWSER_SESSION_STALE",
    });
  });

  it("does not couple Browser affinity to transport connection generation", () => {
    const before = selectBrowserExecutionRoute({
      affinityRuntime: remoteAffinity,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [],
    });
    const afterTransportReconnect = selectBrowserExecutionRoute({
      affinityRuntime: remoteAffinity,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [],
    });
    expect(before).toEqual({ kind: "remote" });
    expect(afterTransportReconnect).toEqual(before);
  });

  it("rejects conflicting explicit device/runtime selectors", () => {
    expect(selectBrowserExecutionRoute({
      requestedDeviceId: deviceA,
      requestedRuntimeId: runtimeId,
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [deviceA],
    })).toMatchObject({
      kind: "error",
      code: "BROWSER_ROUTE_CONFLICT",
    });
  });

  it("requires selection when more than one companion Browser is available", () => {
    expect(selectBrowserExecutionRoute({
      remote: { runtimeId, online: true, browserEpoch: epochA },
      companionDeviceIds: [deviceA, deviceB],
    })).toMatchObject({
      kind: "error",
      code: "DEVICE_SELECTION_REQUIRED",
    });
  });
});
