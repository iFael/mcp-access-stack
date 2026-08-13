import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { groupSamples } from "./stats.mjs";

export async function writeReports(outputDirectory, samples, metadata = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const summaries = groupSamples(samples);
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "samples.ndjson"),
      samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
      "utf8",
    ),
    writeFile(
      path.join(outputDirectory, "summary.json"),
      JSON.stringify({ metadata, summaries }, null, 2) + "\n",
      "utf8",
    ),
    writeFile(path.join(outputDirectory, "summary.csv"), toCsv(summaries), "utf8"),
    writeFile(
      path.join(outputDirectory, "summary.md"),
      toMarkdown(summaries, metadata),
      "utf8",
    ),
  ]);
  return { summaries, outputDirectory };
}

function toCsv(rows) {
  const columns = [
    "route", "tool", "scenario", "cold", "concurrency", "count",
    "successCount", "errorCount", "successRate", "min", "p50", "p90",
    "p95", "p99", "max", "mean", "stddev", "cv",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function toMarkdown(rows, metadata) {
  const generatedAt = metadata.generatedAt ?? new Date().toISOString();
  const header = [
    "# MCP performance benchmark",
    "",
    `Generated at: ${generatedAt}`,
    "",
    "Primary comparison metric: p95. Durations are milliseconds.",
    "",
    "| Route | Tool | Scenario | State | C | Success | p50 | p95 | p99 | Mean | CV |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const body = rows
    .map((row) =>
      [
        row.route,
        row.tool,
        row.scenario,
        row.cold ? "cold" : "warm",
        row.concurrency,
        `${row.successCount}/${row.count}`,
        numberCell(row.p50),
        numberCell(row.p95),
        numberCell(row.p99),
        numberCell(row.mean),
        numberCell(row.cv, 3),
      ]
        .map((cell) => escapeMarkdown(cell))
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    )
    .join("\n");
  return [...header, body, ""].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function numberCell(value, digits = 2) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(digits);
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|");
}
