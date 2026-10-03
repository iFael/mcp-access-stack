import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fail } from "../errors.js";
import { LEDGER_MIGRATIONS } from "./migrations.js";

export interface SqliteReleaseLedgerOptions {
  readonly databasePath: string;
  readonly releaseRoot: string;
  readonly busyTimeoutMs?: number;
}

export class SqliteReleaseLedger {
  private readonly database: DatabaseSync;
  private closed = false;

  private constructor(
    database: DatabaseSync,
    public readonly databasePath: string,
  ) {
    this.database = database;
  }

  public static open(options: SqliteReleaseLedgerOptions): SqliteReleaseLedger {
    const databasePath = resolveLedgerPath(options.databasePath, options.releaseRoot);
    const database = new DatabaseSync(databasePath);
    const ledger = new SqliteReleaseLedger(database, databasePath);

    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`PRAGMA busy_timeout = ${boundedBusyTimeout(options.busyTimeoutMs)}`);
      const journal = database.prepare("PRAGMA journal_mode = WAL").get() as
        | { journal_mode?: string }
        | undefined;
      if (String(journal?.journal_mode).toLowerCase() !== "wal") {
        fail("LEDGER_SCHEMA_INVALID", "SQLite did not enable WAL journal mode.");
      }
      database.exec("PRAGMA synchronous = FULL");
      const synchronous = database.prepare("PRAGMA synchronous").get() as
        | { synchronous?: number }
        | undefined;
      if (Number(synchronous?.synchronous) !== 2) {
        fail("LEDGER_SCHEMA_INVALID", "SQLite did not enable FULL synchronous mode.");
      }
      ledger.migrate();
      if (process.platform !== "win32") chmodSync(databasePath, 0o600);
      return ledger;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public transaction<T>(work: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      if (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
      ) {
        throw new TypeError("SQLite ledger transactions must be synchronous.");
      }
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the operation error; SQLite may already have rolled back.
      }
      throw error;
    }
  }

  public run(sql: string, parameters: readonly SQLInputValue[] = []): void {
    this.assertOpen();
    this.database.prepare(sql).run(...parameters);
  }

  public get<T extends object>(
    sql: string,
    parameters: readonly SQLInputValue[] = [],
  ): T | undefined {
    this.assertOpen();
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }

  public all<T extends object>(
    sql: string,
    parameters: readonly SQLInputValue[] = [],
  ): T[] {
    this.assertOpen();
    return this.database.prepare(sql).all(...parameters) as T[];
  }

  public close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = this.database
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; checksum: string }>;
    const knownVersions = new Set(LEDGER_MIGRATIONS.map((migration) => migration.version));
    const unsupportedVersion = applied.find((item) => !knownVersions.has(item.version));
    if (unsupportedVersion) {
      fail(
        "LEDGER_SCHEMA_INVALID",
        `Ledger migration ${unsupportedVersion.version} is newer than this orchestrator.`,
      );
    }

    for (const migration of LEDGER_MIGRATIONS) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const existing = applied.find((item) => item.version === migration.version);
      if (existing) {
        if (existing.checksum !== checksum) {
          fail(
            "LEDGER_SCHEMA_INVALID",
            `Migration ${migration.version} checksum differs from the applied ledger.`,
          );
        }
        continue;
      }

      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare(
            "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, checksum, new Date().toISOString());
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      fail("LEDGER_SCHEMA_INVALID", "SQLite release ledger is closed.");
    }
  }
}

function resolveLedgerPath(databasePath: string, releaseRoot: string): string {
  if (!path.isAbsolute(databasePath) || !path.isAbsolute(releaseRoot)) {
    fail("LEDGER_PATH_INVALID", "Ledger and release root paths must be absolute.");
  }

  const lexicalDatabase = path.resolve(databasePath);
  const lexicalReleaseRoot = path.resolve(releaseRoot);
  assertOutside(lexicalDatabase, lexicalReleaseRoot);

  if (!existsSync(lexicalReleaseRoot)) {
    fail("LEDGER_PATH_INVALID", "Release root must exist before opening the ledger.");
  }
  if (!lstatSync(lexicalReleaseRoot).isDirectory()) {
    fail("LEDGER_PATH_INVALID", "Release root must be a directory.");
  }

  const lexicalParent = path.dirname(lexicalDatabase);
  mkdirSync(lexicalParent, { recursive: true });
  const realReleaseRoot = realpathSync(lexicalReleaseRoot);
  const realParent = realpathSync(lexicalParent);
  const resolvedDatabase = path.join(realParent, path.basename(lexicalDatabase));
  assertOutside(resolvedDatabase, realReleaseRoot);

  try {
    const databaseEntry = lstatSync(resolvedDatabase);
    if (databaseEntry.isSymbolicLink()) {
      fail("LEDGER_PATH_INVALID", "Ledger database cannot be a symbolic link.");
    }
    assertOutside(realpathSync(resolvedDatabase), realReleaseRoot);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      // A new database file will be created here by SQLite.
    } else {
      throw error;
    }
  }
  return resolvedDatabase;
}

function assertOutside(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  const inside =
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
  if (inside) {
    fail(
      "LEDGER_PATH_INVALID",
      "SQLite ledger must be stored outside the immutable release tree.",
    );
  }
}

function boundedBusyTimeout(value: number | undefined): number {
  if (value === undefined) return 5_000;
  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    fail("INVALID_ARGUMENT", "SQLite busyTimeoutMs must be between 0 and 60000.");
  }
  return value;
}
