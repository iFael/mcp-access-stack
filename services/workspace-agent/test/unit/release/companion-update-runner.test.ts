import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { CompanionUpdateRunner, type CompanionUpdateStatus } from "../../../src/mcp-update/companion-update-runner.js";
import type { ReleaseInstallPort } from "../../../src/mcp-update/release-install.js";

const UPDATE = "upd_00000000-0000-4000-8000-000000000001";
const OTHER = "upd_00000000-0000-4000-8000-000000000002";
const TAG = "v1.1.0-companion.4242";

function device() {
  const calls: string[] = [];
  const state = { active: "1.1.0-companion.40000" as string | null, candidate: null as string | null };
  const port: ReleaseInstallPort = {
    releaseState: async () => ({ ...state }),
    prepare: async (tag) => {
      calls.push(`prepare ${tag}`);
      state.candidate = tag.slice(1);
      return { status: "started", taskId: "task_1" };
    },
    task: async () => "succeeded",
    promote: async (releaseId) => {
      calls.push(`promote ${releaseId}`);
      return { status: "handover_started" };
    },
  };
  return { calls, state, port };
}

describe("the Windows half of an MCP update on the companion", () => {
  let directory: string;
  const statuses: CompanionUpdateStatus[] = [];
  const companion = (port: ReleaseInstallPort | null,
    sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))) =>
    new CompanionUpdateRunner({ stateDirectory: directory, port: () => port, report: (status) => statuses.push(status),
      sleep, pollMs: 1, stepTimeoutMs: 60_000 });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "companion-update-"));
    statuses.length = 0;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("prepares and promotes once, and the companion its promote starts finishes the wait", async () => {
    const env = device();
    // The companion is replaced while it waits for the swap: it never wakes again.
    const first = companion(env.port, () => new Promise(() => undefined));
    await first.handle({ updateId: UPDATE, tag: TAG });
    await first.handle({ updateId: UPDATE, tag: TAG });
    for (let tries = 0; tries < 1_000 && !env.calls.includes("promote 1.1.0-companion.4242"); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(statuses.at(-1)).toEqual({ updateId: UPDATE, phase: "promote", state: "running" });
    // The updater task swaps the release and starts the new companion.
    Object.assign(env.state, { active: "1.1.0-companion.4242", candidate: null });

    const second = companion(env.port);
    await second.recover();
    expect(await second.settled(UPDATE)).toMatchObject({ state: "succeeded", phase: "promote" });
    await second.handle({ updateId: UPDATE, tag: TAG });
    expect(statuses.at(-1)).toEqual({ updateId: UPDATE, phase: "promote", state: "succeeded" });
    expect(env.calls).toEqual(["prepare v1.1.0-companion.4242", "promote 1.1.0-companion.4242"]);
  });

  it("calls a return to the old release a rollback", async () => {
    const env = device();
    env.port.promote = async () => {
      env.state.candidate = null;
      return { status: "handover_started" };
    };
    const runner = companion(env.port);
    await runner.handle({ updateId: UPDATE, tag: TAG });
    expect(await runner.settled(UPDATE)).toMatchObject({ state: "failed", phase: "promote", error: { code: "ROLLED_BACK" } });
  });

  it("is done at once when the release is already active, and installs one update at a time", async () => {
    const env = device();
    env.state.active = "1.1.0-companion.4242";
    const runner = companion(env.port);
    await runner.handle({ updateId: UPDATE, tag: TAG });
    expect(await runner.settled(UPDATE)).toMatchObject({ state: "succeeded" });
    expect(env.calls).toEqual([]);

    const busy = device();
    busy.port.task = async () => "running";
    const slow = new CompanionUpdateRunner({ stateDirectory: path.join(directory, "busy"), port: () => busy.port,
      report: (status) => statuses.push(status), sleep: () => new Promise(() => undefined), pollMs: 1 });
    await slow.handle({ updateId: UPDATE, tag: TAG });
    while ((await slow.read(UPDATE))?.data.prepareTaskId === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    await slow.handle({ updateId: OTHER, tag: "v1.1.0-companion.4243" });
    expect(statuses.at(-1)).toMatchObject({ updateId: OTHER, state: "failed", error: { code: "UPDATE_IN_PROGRESS" } });
  });

  it("ignores what is not a companion release, and says when it has no stack workspace", async () => {
    const runner = companion(null);
    await runner.handle({ updateId: UPDATE, tag: "v1.1.0-beta.103-connector.1" });
    expect(statuses).toEqual([]);
    await runner.handle({ updateId: UPDATE, tag: TAG });
    expect(await runner.settled(UPDATE)).toMatchObject({ state: "failed", error: { code: "WORKSPACE_MISSING" } });
  });
});
