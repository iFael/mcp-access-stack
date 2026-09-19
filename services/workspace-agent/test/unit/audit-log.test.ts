import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuditEntry } from "@vs-code-gpt/shared";
import { AuditLogger } from "../../src/audit-log.js";

let dataDirectory = "";
let previousDataDirectory: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.VS_CODE_GPT_DATA_DIR;
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-audit-"));
  process.env.VS_CODE_GPT_DATA_DIR = dataDirectory;
});

afterEach(async () => {
  if (dataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true });
  }
  if (previousDataDirectory === undefined) {
    delete process.env.VS_CODE_GPT_DATA_DIR;
  } else {
    process.env.VS_CODE_GPT_DATA_DIR = previousDataDirectory;
  }
  dataDirectory = "";
});

function entry(id: number): AuditEntry {
  return {
    timestamp: new Date(1_700_000_000_000 + id).toISOString(),
    operation: "readFile",
    workspaceId: "test",
    correlationId: `corr-${id}`,
    durationMs: id,
    status: "allowed",
  };
}

async function readAuditEntries(): Promise<AuditEntry[]> {
  const files = (await readdir(dataDirectory))
    .filter((name) => name === "audit.ndjson" || /^audit\..+\.ndjson$/u.test(name))
    .sort();
  const entries: AuditEntry[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dataDirectory, file), "utf8");
    for (const line of text.trim().split("\n")) {
      if (line) entries.push(JSON.parse(line) as AuditEntry);
    }
  }
  return entries;
}

describe("AuditLogger", () => {
  it("rotates the active audit before appending past the chunk limit and reports write timing", async () => {
    const logger = await AuditLogger.create([], {
      maxFileBytes: 1,
      maxRotatedFiles: 4,
    });

    const first = await logger.write(entry(1));
    const second = await logger.write(entry(2));

    expect(first.rotated).toBe(false);
    expect(second.rotated).toBe(true);
    expect(first.appendDurationMs).toBeGreaterThanOrEqual(0);
    expect(second.appendDurationMs).toBeGreaterThanOrEqual(0);
    expect(second.totalDurationMs).toBeGreaterThanOrEqual(second.appendDurationMs);

    const files = await readdir(dataDirectory);
    expect(files.filter((name) => /^audit\..+\.ndjson$/u.test(name))).toHaveLength(1);

    const entries = await readAuditEntries();
    expect(entries.map((value) => value.correlationId).sort()).toEqual([
      "corr-1",
      "corr-2",
    ]);
  });

  it("serializes concurrent writes so every audit entry remains valid exactly once across rotations", async () => {
    const logger = await AuditLogger.create([], {
      maxFileBytes: 1,
      maxRotatedFiles: 64,
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => logger.write(entry(index + 1))),
    );

    const entries = await readAuditEntries();
    expect(entries).toHaveLength(20);
    expect(
      entries
        .map((value) => value.correlationId)
        .sort((left, right) => Number(left!.slice(5)) - Number(right!.slice(5))),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `corr-${index + 1}`));
  });

  it("retains only the configured number of rotated chunks", async () => {
    const logger = await AuditLogger.create([], {
      maxFileBytes: 1,
      maxRotatedFiles: 2,
    });

    for (let index = 1; index <= 5; index += 1) {
      await logger.write(entry(index));
    }

    const files = await readdir(dataDirectory);
    expect(files.filter((name) => /^audit\..+\.ndjson$/u.test(name))).toHaveLength(2);

    const entries = await readAuditEntries();
    expect(entries.map((value) => value.correlationId).sort()).toEqual([
      "corr-3",
      "corr-4",
      "corr-5",
    ]);
  });

  it("fails closed when the active audit path cannot be appended", async () => {
    const logger = await AuditLogger.create([], {
      maxFileBytes: 1024 * 1024,
      maxRotatedFiles: 4,
    });

    await logger.write(entry(1));
    const activePath = path.join(dataDirectory, "audit.ndjson");
    await rm(activePath, { force: true });
    await mkdir(activePath);

    await expect(logger.write(entry(2))).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    });
  });
});
