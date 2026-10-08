import { pathToFileURL } from "node:url";

const TAG_PATTERN = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u;

export class BootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
  }
}

function requireInput(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) throw new BootstrapError(code);
  return value;
}

function gitRef(body, name) {
  if (!body || body.ref !== name || body.object?.type !== "commit" ||
      !SHA_PATTERN.test(body.object?.sha ?? "")) {
    throw new BootstrapError("GIT_REF_INVALID");
  }
  return body.object.sha;
}

function createApi(repository, token, fetchImpl) {
  return async (method, resource, body) => {
    const headers = {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "mcp-v3-bounded-release-tag-bootstrap",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl("https://api.github.com/repos/" + repository + resource, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BootstrapError("API_OUTCOME_UNKNOWN");
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, body: payload };
  };
}

async function readRef(api, resource, fullRef) {
  const result = await api("GET", "/git/ref/" + resource);
  if (result.status === 404) return null;
  if (result.status !== 200) throw new BootstrapError("GIT_REF_READ_FAILED");
  return gitRef(result.body, fullRef);
}

export async function bootstrapReleaseTag(input, fetchImpl = fetch) {
  const {
    tag, expectedSha, repository, token,
    eventName, eventRef, eventSha, workflowRunId,
  } = input;
  if (eventName !== "workflow_dispatch" || eventRef !== "refs/heads/main") {
    throw new BootstrapError("WORKFLOW_MAIN_ONLY");
  }
  const requestedSha = requireInput(expectedSha, SHA_PATTERN, "EXPECTED_SHA_INVALID");
  if (eventSha !== requestedSha) throw new BootstrapError("WORKFLOW_SHA_MISMATCH");
  const releaseTag = requireInput(tag, TAG_PATTERN, "RELEASE_TAG_INVALID");
  if (releaseTag.length > 64 || releaseTag.endsWith(".lock")) {
    throw new BootstrapError("RELEASE_TAG_INVALID");
  }
  requireInput(repository, REPOSITORY_PATTERN, "REPOSITORY_INVALID");
  if (!token || typeof token !== "string") throw new BootstrapError("GITHUB_TOKEN_MISSING");

  const api = createApi(repository, token, fetchImpl);
  const main = await readRef(api, "heads/main", "refs/heads/main");
  if (main !== requestedSha) throw new BootstrapError("REMOTE_MAIN_SHA_MISMATCH");

  const checks = await api(
    "GET",
    "/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=" +
      requestedSha + "&per_page=100",
  );
  if (checks.status !== 200 || !Array.isArray(checks.body?.workflow_runs)) {
    throw new BootstrapError("MAIN_CI_LOOKUP_FAILED");
  }
  const ci = checks.body.workflow_runs.find((run) =>
    run.head_sha === requestedSha &&
    run.head_branch === "main" &&
    run.event === "push" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    Number.isSafeInteger(run.id) && run.id > 0
  );
  if (!ci) throw new BootstrapError("MAIN_CI_NOT_GREEN");

  const refResource = "tags/" + releaseTag;
  const fullRef = "refs/tags/" + releaseTag;
  const existing = await readRef(api, refResource, fullRef);
  if (existing !== null) {
    if (existing !== requestedSha) throw new BootstrapError("RELEASE_TAG_CONFLICT");
    return {
      status: "already_published",
      tag: releaseTag,
      sha: requestedSha,
      ciRunId: ci.id,
      workflowRunId,
    };
  }

  // Exactly one create attempt. Uncertain outcomes are reconciled by reading
  // the same immutable ref; the request is never automatically repeated.
  let createStatus = null;
  try {
    const result = await api("POST", "/git/refs", { ref: fullRef, sha: requestedSha });
    createStatus = result.status;
  } catch (error) {
    if (!(error instanceof BootstrapError) || error.code !== "API_OUTCOME_UNKNOWN") throw error;
  }

  let after;
  try {
    after = await readRef(api, refResource, fullRef);
  } catch {
    throw new BootstrapError("TAG_PUBLISH_OUTCOME_UNKNOWN");
  }
  if (after === null) {
    throw new BootstrapError(createStatus === 201 ? "TAG_PUBLISH_OUTCOME_UNKNOWN" :
      createStatus === 422 ? "TAG_CREATE_CONFLICT_UNRESOLVED" :
      createStatus === null ? "TAG_PUBLISH_OUTCOME_UNKNOWN" : "TAG_CREATE_FAILED");
  }
  if (after !== requestedSha) throw new BootstrapError("RELEASE_TAG_CONFLICT");
  return {
    status: createStatus === 201 ? "published" : "reconciled",
    tag: releaseTag,
    sha: requestedSha,
    ciRunId: ci.id,
    workflowRunId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await bootstrapReleaseTag({
      tag: process.env.RELEASE_TAG,
      expectedSha: process.env.EXPECTED_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      eventName: process.env.GITHUB_EVENT_NAME,
      eventRef: process.env.GITHUB_REF,
      eventSha: process.env.GITHUB_SHA,
      workflowRunId: process.env.GITHUB_RUN_ID,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof BootstrapError ? error.code : "TAG_BOOTSTRAP_FAILED");
    process.exitCode = 1;
  }
}
