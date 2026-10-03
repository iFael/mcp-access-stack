import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";

describe("SQLite release ledger", () => {
  let root: string;
  let releaseRoot: string;
  let databasePath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-v3-release-orchestrator-"));
    releaseRoot = path.join(root, "immutable-releases");
    mkdirSync(releaseRoot, { recursive: true });
    databasePath = path.join(root, "state", "orchestrator.sqlite");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses WAL/FULL durability and applies checked migrations idempotently across reopen", () => {
    let ledger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    expect(ledger.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(ledger.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
    expect(ledger.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version"))
      .toEqual([{ version: 1 }, { version: 2 }]);
    ledger.close();

    ledger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    expect(ledger.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version"))
      .toEqual([{ version: 1 }, { version: 2 }]);
    ledger.close();
  });

  it("restores an offline SQLite snapshot with the same run and event sequence", () => {
    const ledger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    const orchestrator = new ReleaseOrchestrator(ledger);
    const { run } = orchestrator.createRun({
      blueprintId: "mcp-v3-public-release",
      blueprintVersion: 1,
      targetRelease: "synthetic-beta80-restore-test",
      sourceCommitSha: "0".repeat(40),
      idempotencyKey: "restore-test-run",
      actorId: "test:restore",
    });
    const started = orchestrator.startRun(run.runId, "test:restore");
    orchestrator.close();

    const backupPath = path.join(root, "offline-backup.sqlite");
    const walPath = `${databasePath}-wal`;
    const backupWalPath = `${backupPath}-wal`;
    copyFileSync(databasePath, backupPath);
    if (existsSync(walPath)) copyFileSync(walPath, backupWalPath);

    rmSync(databasePath, { force: true });
    rmSync(walPath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    copyFileSync(backupPath, databasePath);
    if (existsSync(backupWalPath)) copyFileSync(backupWalPath, walPath);

    const restoredLedger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    const restoredOrchestrator = new ReleaseOrchestrator(restoredLedger);
    expect(restoredOrchestrator.getRun(run.runId)).toMatchObject({
      status: "running",
      lastSeq: started.lastSeq,
    });
    expect(restoredOrchestrator.replayEvents(run.runId).map((event) => event.seq)).toEqual([
      1,
      2,
    ]);
    restoredOrchestrator.close();
  });

  it("fails closed when a ledger schema was written by a newer orchestrator", () => {
    const ledger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    ledger.run(
      "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
      [99, "f".repeat(64), new Date().toISOString()],
    );
    ledger.close();

    expect(() => SqliteReleaseLedger.open({ databasePath, releaseRoot })).toThrow(
      expect.objectContaining({ code: "LEDGER_SCHEMA_INVALID" }),
    );
  });

  it("serializes writes across ledger connections with SQLite's single-writer lock", () => {
    const first = SqliteReleaseLedger.open({
      databasePath,
      releaseRoot,
      busyTimeoutMs: 50,
    });
    const second = SqliteReleaseLedger.open({
      databasePath,
      releaseRoot,
      busyTimeoutMs: 10,
    });
    let secondWriterFailed = false;

    first.transaction(() => {
      try {
        second.transaction(() => undefined);
      } catch {
        secondWriterFailed = true;
      }
    });

    expect(secondWriterFailed).toBe(true);
    first.close();
    second.close();
  });

  it("rejects a ledger inside the immutable release tree", () => {
    expect(() =>
      SqliteReleaseLedger.open({
        databasePath: path.join(releaseRoot, "active", "orchestrator.sqlite"),
        releaseRoot,
      }),
    ).toThrow(expect.objectContaining({ code: "LEDGER_PATH_INVALID" }));
  });

  it("prevents event log mutation", () => {
    const ledger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    const orchestrator = new ReleaseOrchestrator(ledger);
    const { run } = orchestrator.createRun({
      blueprintId: "mcp-v3-public-release",
      blueprintVersion: 1,
      targetRelease: "synthetic-beta80-ledger-test",
      sourceCommitSha: "0".repeat(40),
      idempotencyKey: "ledger-test-run",
      actorId: "test:ledger",
    });
    expect(() =>
      ledger.run("DELETE FROM run_events WHERE run_id = ? AND seq = 1", [run.runId]),
    ).toThrow();
    orchestrator.close();
  });
});
