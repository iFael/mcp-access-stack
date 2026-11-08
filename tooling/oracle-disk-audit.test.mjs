import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, classifyDuError, parseArgs } from "./oracle-disk-audit.mjs";

test("fixed groups and bounded pagination reject untrusted paths and oversized requests", () => {
  assert.deepEqual(parseArgs(["--group=releases", "--start=2", "--limit=3"]),
    { group: "releases", start: 2, limit: 3 });
  for (const args of [
    ["--group=/root"], ["--path=/root"], ["--limit=6"],
    ["--start=-1"], ["--start=1.5"], ["--start=9999999999999999999"],
    ["--group=releases", "--group=worktrees"], ["--group=system", "--limit=2"],
    ["--group=releases", "--limit=4"],
  ]) assert.throws(() => parseArgs(args));
});

test("reports inaccessible paths without claiming completeness or inventing byte counts", async () => {
  const result = await audit({ group: "releases", start: 0, limit: 2 }, {
    readdir: async () => [
      { name: "a", isDirectory: () => true }, { name: "b", isDirectory: () => true },
    ],
    statfs: async () => ({ bsize: 4096n, blocks: 100n, bfree: 10n, bavail: 8n }),
    diskSize: async pathname => pathname.endsWith("/a")
      ? { path: pathname, status: "measured", allocatedBytes: 2048 }
      : { path: pathname, status: "permission_denied" },
  });
  assert.equal(result.complete, false);
  assert.equal(result.measuredBytes, 2048);
  assert.equal(result.filesystem.usedBytes, 368640);
  assert.equal(result.nextStart, null);
  assert.deepEqual(result.targets.map(item => item.status), ["measured", "permission_denied"]);
});

test("permission errors from du are not silently converted into full measurements", () => {
  assert.equal(classifyDuError({ code: 1, stderr: "du: /var/cache/private: Permission denied" }), "permission_denied");
  assert.equal(classifyDuError({ killed: true, code: "ETIMEDOUT" }), "timed_out");
  assert.equal(classifyDuError({ code: "ENOENT" }), "missing");
  assert.equal(classifyDuError({ code: 1, stderr: "I/O error" }), "failed");
});

test("pagination returns exact scope and never claims global filesystem completeness", async () => {
  const result = await audit({ group: "releases", start: 1, limit: 2 }, {
    readdir: async () => [
      { name: "b", isDirectory: () => true }, { name: "a", isDirectory: () => true },
      { name: "file", isDirectory: () => false }, { name: "c", isDirectory: () => true },
    ],
    statfs: async () => { throw new Error("not available"); },
    diskSize: async pathname => ({ path: pathname, status: "measured", allocatedBytes: 100 }),
  });
  assert.equal(result.count, 3);
  assert.equal(result.nextStart, null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.targets.map(item => item.path.split("/").at(-1)), ["b", "c"]);
  assert.equal(result.filesystem, null);
});

test("entire selected group may be complete without equating it to a full disk scan", async () => {
  const result = await audit({ group: "worktrees", start: 0, limit: 3 }, {
    readdir: async () => [{ name: "only", isDirectory: () => true }],
    statfs: async () => ({ bsize: 1n, blocks: 100n, bfree: 20n, bavail: 15n }),
    diskSize: async pathname => ({ path: pathname, status: "measured", allocatedBytes: 42 }),
  });
  assert.equal(result.complete, true);
  assert.equal(result.count, 1);
  assert.equal(result.measuredBytes, 42);
  assert.equal(result.filesystem.usedBytes, 80);
});
