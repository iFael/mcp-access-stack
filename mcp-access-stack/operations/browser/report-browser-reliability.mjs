import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function summarizeBrowserAudit(lines) {
  const rows = [];
  let malformedLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object") throw new Error("invalid row");
      rows.push(value);
    } catch {
      malformedLines += 1;
    }
  }

  const operations = new Map();
  const reasons = new Map();
  for (const row of rows) {
    const operation = typeof row.operation === "string" ? row.operation : "unknown";
    const aggregate = operations.get(operation) ?? {
      count: 0,
      allowed: 0,
      errors: 0,
      denied: 0,
      durations: [],
      queueWaits: [],
      unitDurations: [],
      operationUnits: 0,
    };
    aggregate.count += 1;
    if (row.status === "allowed") aggregate.allowed += 1;
    if (row.status === "error") aggregate.errors += 1;
    if (row.status === "denied") aggregate.denied += 1;
    if (Number.isFinite(row.durationMs)) aggregate.durations.push(row.durationMs);
    if (Number.isFinite(row.queueWaitMs)) aggregate.queueWaits.push(row.queueWaitMs);
    const operationUnits = Number.isInteger(row.operationUnits) && row.operationUnits > 0
      ? row.operationUnits
      : 1;
    aggregate.operationUnits += operationUnits;
    if (Number.isFinite(row.durationMs)) {
      aggregate.unitDurations.push(row.durationMs / operationUnits);
    }
    operations.set(operation, aggregate);
    if (typeof row.reason === "string" && row.reason) {
      reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
    }
  }

  const allowed = rows.filter((row) => row.status === "allowed").length;
  const errors = rows.filter((row) => row.status === "error").length;
  const denied = rows.filter((row) => row.status === "denied").length;
  return {
    entries: rows.length,
    malformedLines,
    allowed,
    errors,
    denied,
    errorRatePercent: rows.length === 0
      ? 0
      : round((errors / rows.length) * 100, 2),
    reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    operations: [...operations]
      .map(([operation, aggregate]) => ({
        operation,
        count: aggregate.count,
        allowed: aggregate.allowed,
        errors: aggregate.errors,
        denied: aggregate.denied,
        p50Ms: percentile(aggregate.durations, 0.5),
        p95Ms: percentile(aggregate.durations, 0.95),
        maxMs: maximum(aggregate.durations),
        queueP95Ms: percentile(aggregate.queueWaits, 0.95),
        operationUnits: aggregate.operationUnits,
        p50MsPerUnit: percentile(aggregate.unitDurations, 0.5),
        p95MsPerUnit: percentile(aggregate.unitDurations, 0.95),
      }))
      .sort((left, right) => right.count - left.count || left.operation.localeCompare(right.operation)),
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return round(sorted[index], 3);
}

function maximum(values) {
  return values.length === 0 ? 0 : round(Math.max(...values), 3);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function resolveBrowserAuditPath(
  argument = process.argv[2],
  cwd = process.cwd(),
) {
  if (argument) return argument;
  try {
    const configPath = path.join(cwd, ".runtime-private", "gpt-only-production.json");
    const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^﻿/u, ""));
    const runtimeDirectory = config?.browser?.runtimeDirectory;
    if (typeof runtimeDirectory === "string" && runtimeDirectory.length > 0) {
      return path.join(runtimeDirectory, "browser-audit.ndjson");
    }
  } catch {
    // Development and test environments may not have a private production config.
  }
  return path.join(cwd, "runtime", "browser", "browser-audit.ndjson");
}

async function main() {
  const filePath = await resolveBrowserAuditPath();
  const content = await readFile(filePath, "utf8");
  process.stdout.write(`${JSON.stringify(summarizeBrowserAudit(content.split(/\r?\n/u)), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
