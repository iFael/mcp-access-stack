import { pathToFileURL } from "node:url";
import path from "node:path";

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ASSET_SUFFIX = /^-(?:windows-x64\.zip|linux-(?:x64|arm64)\.tar\.gz|darwin-(?:x64|arm64)\.tar\.gz)$/u;

function parseTag(tag) {
  const m = TAG.exec(tag ?? "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : null };
}
function compareIdentifiers(a, b) {
  const aNum = /^\d+$/u.test(a);
  const bNum = /^\d+$/u.test(b);
  if (aNum && bNum) {
    const x = BigInt(a), y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}
export function compareReleaseTags(a, b) {
  const x = parseTag(a), y = parseTag(b);
  if (!x || !y) throw new Error("RELEASE_TAG_INVALID");
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const diff = compareIdentifiers(x.pre[i], y.pre[i]);
    if (diff !== 0) return diff;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

export function selectPublishedRelease(releases, { channel, assetSuffix, currentReleaseId }) {
  if (!Array.isArray(releases) || releases.length > 100 ||
      !["stable", "prerelease", "companion"].includes(channel) || !ASSET_SUFFIX.test(assetSuffix) ||
      !parseTag("v" + currentReleaseId)) throw new Error("RELEASE_SELECTION_INVALID");
  const eligible = releases.filter(release => {
    if (!release || release.draft !== false || !parseTag(release.tag_name) ||
        !Array.isArray(release.assets)) return false;
    const companion = /-companion\.[1-9][0-9]*$/u.test(release.tag_name);
    const oracleOnly = /-oracle\./u.test(release.tag_name);
    if (channel === "stable" ? release.prerelease || companion || oracleOnly
      : channel === "companion" ? !release.prerelease || !companion
      : !release.prerelease || companion || oracleOnly) return false;
    const asset = release.tag_name + assetSuffix;
    const names = release.assets.map(x => x?.name);
    return names.includes(asset) && names.includes(asset + ".sha256");
  });
  eligible.sort((a, b) => compareReleaseTags(b.tag_name, a.tag_name));
  const selected = eligible[0];
  if (!selected || compareReleaseTags(selected.tag_name, "v" + currentReleaseId) <= 0) {
    return { status: "up-to-date" };
  }
  return { status: "available", tag: selected.tag_name };
}

export async function resolvePublishedRelease({ repository, channel, assetSuffix, currentReleaseId },
    fetchImpl = fetch) {
  if (!REPOSITORY.test(repository) || repository.split("/").some(part =>
      part.startsWith(".") || part.includes(".."))) throw new Error("RELEASE_REPOSITORY_INVALID");
  const url = "https://api.github.com/repos/" + repository + "/releases?per_page=100";
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "mcp-v3-local-updater" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("RELEASE_CATALOG_UNAVAILABLE");
  const releases = await response.json();
  // The anonymous catalog has been observed returning a transient empty page;
  // never report that as "up-to-date" when this repository always has releases.
  if (Array.isArray(releases) && releases.length === 0) throw new Error("RELEASE_CATALOG_EMPTY");
  return selectPublishedRelease(releases, { channel, assetSuffix, currentReleaseId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [repository, channel, assetSuffix, currentReleaseId] = process.argv.slice(2);
    if (process.argv.length !== 6) throw new Error("RELEASE_ARGUMENTS_INVALID");
    const selected = await resolvePublishedRelease({ repository, channel, assetSuffix, currentReleaseId });
    process.stdout.write((selected.status === "available" ? selected.tag : "") + "\n");
  } catch {
    // Never expose remote response text, URLs, or raw errors from the catalog.
    process.stderr.write("RELEASE_CATALOG_REFUSED\n");
    process.exitCode = 1;
  }
}
