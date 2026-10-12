import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CI_RUN = /^[1-9][0-9]{0,15}$/u;

export function verifyOracleSourceArtifact({
  source,
  checksum,
  manifest,
  archiveName,
  expectedSha,
  expectedCiRun,
}) {
  if (!SHA.test(expectedSha ?? "") || !CI_RUN.test(expectedCiRun ?? "")) {
    throw new Error("EXPECTED_IDENTITY_INVALID");
  }
  const requiredName = "oracle-linux-source-" + expectedSha + ".tar.gz";
  if (archiveName !== requiredName || !Buffer.isBuffer(source) || source.length === 0) {
    throw new Error("SOURCE_ARCHIVE_INVALID");
  }
  const hash = createHash("sha256").update(source).digest("hex");
  if (!DIGEST.test(hash) || checksum !== hash + "  " + requiredName + "\n") {
    throw new Error("SOURCE_CHECKSUM_MISMATCH");
  }
  const requiredKeys = [
    "artifactName", "artifactSha256", "ciRunId", "kind",
    "product", "schemaVersion", "sourceCommit",
  ];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(requiredKeys.sort()) ||
      manifest.schemaVersion !== 1 || manifest.product !== "mcp-access-stack" ||
      manifest.kind !== "source-archive" ||
      manifest.sourceCommit !== expectedSha || manifest.ciRunId !== expectedCiRun ||
      manifest.artifactName !== requiredName || manifest.artifactSha256 !== hash) {
    throw new Error("SOURCE_MANIFEST_MISMATCH");
  }
  return { status: "verified", sourceCommit: expectedSha, ciRunId: expectedCiRun };
}

async function main(args) {
  if (args.length !== 5) throw new Error("ARGUMENTS_INVALID");
  const [archivePath, checksumPath, manifestPath, expectedSha, expectedCiRun] = args;
  const source = await readFile(archivePath);
  const checksum = await readFile(checksumPath, "utf8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = verifyOracleSourceArtifact({
    source, checksum, manifest, archiveName: path.basename(archivePath),
    expectedSha, expectedCiRun,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    const allowed = new Set([
      "ARGUMENTS_INVALID", "EXPECTED_IDENTITY_INVALID", "SOURCE_ARCHIVE_INVALID",
      "SOURCE_CHECKSUM_MISMATCH", "SOURCE_MANIFEST_MISMATCH",
    ]);
    process.stderr.write(allowed.has(error?.message) ? error.message + "\n" : "SOURCE_VERIFICATION_FAILED\n");
    process.exitCode = 1;
  });
}
