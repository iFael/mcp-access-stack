import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { acquireCompanionInstanceLock } from "../../../src/companion/companion-instance-lock.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("companion single-instance lock", () => {
  it("acquires and releases one companion lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-companion-lock-"));
    temporaryRoots.push(root);

    const lease = await acquireCompanionInstanceLock({
      stateRoot: root,
      releaseRoot: path.join(root, "release-a"),
      pid: 101,
      processAlive: () => false,
    });

    const persisted = JSON.parse(await readFile(lease.lockPath, "utf8")) as {
      pid: number;
      instanceId: string;
    };
    expect(persisted.pid).toBe(101);
    expect(persisted.instanceId).toBe(lease.instanceId);

    await lease.release();
    await expect(readFile(lease.lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second companion while the recorded process is alive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-companion-lock-"));
    temporaryRoots.push(root);

    const first = await acquireCompanionInstanceLock({
      stateRoot: root,
      releaseRoot: path.join(root, "release-a"),
      pid: 101,
      processAlive: (pid) => pid === 101,
    });

    await expect(
      acquireCompanionInstanceLock({
        stateRoot: root,
        releaseRoot: path.join(root, "release-b"),
        pid: 202,
        processAlive: (pid) => pid === 101,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });

    await first.release();
  });

  it("recovers a stale lock left by a dead companion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-companion-lock-"));
    temporaryRoots.push(root);
    const stateDirectory = path.join(root, "state");
    const stalePath = path.join(stateDirectory, "companion-instance.v1.json");
    const stale = await acquireCompanionInstanceLock({
      stateRoot: root,
      releaseRoot: path.join(root, "release-old"),
      pid: 101,
      processAlive: () => false,
    });
    await writeFile(
      stalePath,
      JSON.stringify({
        version: 1,
        instanceId: "stale-instance",
        pid: 101,
        releaseRoot: path.join(root, "release-old"),
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const recovered = await acquireCompanionInstanceLock({
      stateRoot: root,
      releaseRoot: path.join(root, "release-new"),
      pid: 202,
      processAlive: () => false,
    });
    const persisted = JSON.parse(await readFile(recovered.lockPath, "utf8")) as { pid: number };
    expect(persisted.pid).toBe(202);

    await recovered.release();
    await stale.release();
  });
});
