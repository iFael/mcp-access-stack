import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapReleaseTag } from "./bootstrap-release-tag.mjs";

const SHA = "9e61e52afea67add59561a7d2f94ffebc51019ca";
const OTHER = "860393252316edc211ec7c2127186514f8fe55df";
const TAG = "v1.1.0-beta.84";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(options = {}) {
  const input = {
    tag: TAG,
    expectedSha: SHA,
    repository: "iFael/mcp-access-stack",
    token: "synthetic-token-not-used-on-network",
    eventName: "workflow_dispatch",
    eventRef: "refs/heads/main",
    eventSha: SHA,
    workflowRunId: "999001",
    ...options.input,
  };
  let remoteTag = options.tagSha ?? null;
  const calls = [];
  const respond = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const suffix = url.pathname.replace("/repos/iFael/mcp-access-stack", "");
    const method = init.method;
    calls.push({
      method,
      path: suffix,
      query: url.searchParams,
      body: init.body === undefined ? null : JSON.parse(init.body),
      token: init.headers.authorization,
    });
    assert.equal(init.headers.authorization, "Bearer " + input.token);
    if (method === "GET" && suffix === "/git/ref/heads/main") {
      if (options.mainReadFails) return respond(403, {});
      return respond(200, {
        ref: "refs/heads/main",
        object: { type: "commit", sha: options.mainSha ?? SHA },
      });
    }
    if (method === "GET" && suffix === "/actions/workflows/ci.yml/runs") {
      if (options.ciReadFails) return respond(503, {});
      assert.equal(url.searchParams.get("head_sha"), input.expectedSha);
      return respond(200, {
        workflow_runs: options.ciInvalid ? [] : [{
          id: 37718544668,
          head_sha: SHA,
          head_branch: options.ciWrongBranch ? "feature" : "main",
          status: "completed",
          event: "push",
          conclusion: options.ciFails ? "failure" : "success",
        }],
      });
    }
    if (method === "GET" && suffix === "/git/ref/tags/" + TAG) {
      if (options.tagReadFails) return respond(502, {});
      if (!remoteTag) return respond(404, { message: "Not Found" });
      return respond(200, {
        ref: "refs/tags/" + TAG,
        object: { type: options.tagType ?? "commit", sha: remoteTag },
      });
    }
    if (method === "POST" && suffix === "/git/refs") {
      assert.deepEqual(JSON.parse(init.body), { ref: "refs/tags/" + TAG, sha: SHA });
      if (options.postMode === "throw-after-create") {
        remoteTag = SHA;
        throw new Error("synthetic network error, no real GitHub request");
      }
      if (options.postMode === "throw-no-create") {
        throw new Error("synthetic network error, no real GitHub request");
      }
      if (options.postMode === "conflict-different") {
        remoteTag = OTHER;
        return respond(422, {});
      }
      if (options.postMode === "conflict-same") {
        remoteTag = SHA;
        return respond(422, {});
      }
      if (options.postMode === "denied") return respond(403, {});
      remoteTag = SHA;
      return respond(201, {});
    }
    throw new Error("Unexpected mocked endpoint");
  };
  return {
    input,
    fetchImpl,
    calls,
    posts: () => calls.filter((call) => call.method === "POST"),
    remoteTag: () => remoteTag,
  };
}

test("publishes an exact new release tag once after validating main and canonical CI", async () => {
  const f = fixture();
  const outcome = await bootstrapReleaseTag(f.input, f.fetchImpl);
  assert.deepEqual(outcome, {
    status: "published", tag: TAG, sha: SHA,
    ciRunId: 37718544668, workflowRunId: "999001",
  });
  assert.equal(f.remoteTag(), SHA);
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.calls.map((call) => call.method + " " + call.path), [
    "GET /git/ref/heads/main",
    "GET /actions/workflows/ci.yml/runs",
    "GET /git/ref/tags/" + TAG,
    "POST /git/refs",
    "GET /git/ref/tags/" + TAG,
  ]);
});

test("an identical existing lightweight tag is idempotent without a POST", async () => {
  const f = fixture({ tagSha: SHA });
  assert.equal((await bootstrapReleaseTag(f.input, f.fetchImpl)).status, "already_published");
  assert.equal(f.posts().length, 0);
});

test("a mismatched existing tag fails closed without a POST", async () => {
  const f = fixture({ tagSha: OTHER });
  await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl), { code: "RELEASE_TAG_CONFLICT" });
  assert.equal(f.posts().length, 0);
});

test("an annotated tag cannot masquerade as an exact commit ref", async () => {
  const f = fixture({ tagSha: SHA, tagType: "tag" });
  await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl), { code: "GIT_REF_INVALID" });
  assert.equal(f.posts().length, 0);
});

test("stale remote main or unavailable remote main prevents publication", async () => {
  for (const options of [{ mainSha: OTHER }, { mainReadFails: true }]) {
    const f = fixture(options);
    await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl));
    assert.equal(f.posts().length, 0);
  }
});

test("canonical CI must be successful on the exact main push", async () => {
  for (const options of [
    { ciInvalid: true }, { ciFails: true }, { ciWrongBranch: true }, { ciReadFails: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl));
    assert.equal(f.posts().length, 0);
  }
});

test("rejects other workflow refs, stale dispatch SHA, malformed tags, missing token and arbitrary repository", async () => {
  const cases = [
    { eventRef: "refs/heads/feature" },
    { eventName: "push" },
    { eventSha: OTHER },
    { expectedSha: OTHER },
    { tag: "v1.1.0/evil" },
    { tag: "v1.1.0-beta..84" },
    { tag: "v1.1.0;echo" },
    { tag: "v1.1.0 " },
    { tag: "v1.1.0.lock" },
    { tag: "v1.1.0-beta.lock" },
    { repository: "../another-repo" },
    { token: "" },
  ];
  for (const input of cases) {
    const f = fixture({ input });
    await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl));
    assert.equal(f.calls.length, 0);
  }
});

test("an unknown POST applied exactly once is reconciled against the same tag", async () => {
  const f = fixture({ postMode: "throw-after-create" });
  const result = await bootstrapReleaseTag(f.input, f.fetchImpl);
  assert.equal(result.status, "reconciled");
  assert.equal(f.posts().length, 1);
  assert.equal(f.remoteTag(), SHA);
});

test("an unknown POST with no resulting ref stops without retry", async () => {
  const f = fixture({ postMode: "throw-no-create" });
  await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl), { code: "TAG_PUBLISH_OUTCOME_UNKNOWN" });
  assert.equal(f.posts().length, 1);
});

test("concurrent tag creation reconciles exact identity or rejects a conflicting SHA", async () => {
  const same = fixture({ postMode: "conflict-same" });
  assert.equal((await bootstrapReleaseTag(same.input, same.fetchImpl)).status, "reconciled");
  assert.equal(same.posts().length, 1);
  const other = fixture({ postMode: "conflict-different" });
  await assert.rejects(bootstrapReleaseTag(other.input, other.fetchImpl), { code: "RELEASE_TAG_CONFLICT" });
  assert.equal(other.posts().length, 1);
});

test("a denied POST and absent tag reports failure without retry", async () => {
  const f = fixture({ postMode: "denied" });
  await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl), { code: "TAG_CREATE_FAILED" });
  assert.equal(f.posts().length, 1);
});

test("failure of reconciliation after POST preserves outcome_unknown", async () => {
  const f = fixture({ tagReadFails: true });
  await assert.rejects(bootstrapReleaseTag(f.input, f.fetchImpl), { code: "GIT_REF_READ_FAILED" });
  assert.equal(f.posts().length, 0);
});

test("the new workflow isolates tag bootstrap from the canonical release workflow", async () => {
  const bootstrap = await readFile(path.join(ROOT, ".github/workflows/release-tag-bootstrap.yml"), "utf8");
  const release = await readFile(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(bootstrap, /workflow_dispatch:/u);
  assert.match(bootstrap, /expected_sha:/u);
  assert.match(bootstrap, /environment: public-release/u);
  assert.match(bootstrap, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(bootstrap, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(bootstrap, /persist-credentials: false/u);
  assert.match(bootstrap, /cancel-in-progress: false/u);
  assert.match(bootstrap, /group: release-tag-bootstrap-\$\{\{ inputs\.tag \}\}/u);
  assert.equal(bootstrap.match(/contents: write/gu)?.length, 1);
  assert.match(bootstrap, /node tooling\/release\/bootstrap-release-tag\.mjs/u);
  assert.doesNotMatch(bootstrap, /release create|deploy|secret put|--force/u);
  assert.match(release, /Existing SemVer tag to publish/u);
  assert.match(release, /--verify-tag/u);
});
