import {
  AppError,
  githubIssueWriteInputSchema,
  githubIssueWriteResultSchema,
  githubReadInputSchema,
  githubReadResultSchema,
  type GitHubIssueWriteInput,
  type GitHubIssueWriteResult,
  type GitHubReadInput,
  type GitHubReadResult,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { GitHubApiClient } from "./github-http-client.js";

type FieldValue = string | number | boolean | null | string[];
type Item = Record<string, FieldValue>;
type Raw = Record<string, unknown>;

const DEFAULT_LOG_TAIL_BYTES = 65_536;
const LIST_BODY_CHARS = 2_000;
const DETAIL_BODY_CHARS = 20_000;

/** Typed, read-only GitHub views projected to a few stable fields each. */
export async function readGitHub(
  client: GitHubApiClient,
  input: GitHubReadInput,
  context: OperationContext = {},
): Promise<GitHubReadResult> {
  const parsed = githubReadInputSchema.parse(input);
  const { owner, repository, kind, page, perPage } = parsed;
  const paging = { page: String(page), per_page: String(perPage) };
  if (kind === "job_logs") {
    if (!client.getJobLogTail) throw unsupported();
    const tail = await client.getJobLogTail(owner, repository, parsed.jobId!,
      parsed.tailBytes ?? DEFAULT_LOG_TAIL_BYTES, context);
    return githubReadResultSchema.parse({ kind, items: [], text: tail.text, truncated: tail.truncated, page: 1 });
  }
  if (!client.readRepositoryResource) throw unsupported();
  const read = (resource: readonly (string | number)[], query: Record<string, string> = {}) =>
    client.readRepositoryResource!(owner, repository, resource, query, context);

  let items: Item[];
  let paged = true;
  switch (kind) {
    case "release":
      items = [projectRelease(asRecord(await read(parsed.tag === undefined
        ? ["releases", "latest"] : ["releases", "tags", parsed.tag])))];
      paged = false;
      break;
    case "releases":
      items = asArray(await read(["releases"], paging)).map(projectRelease);
      break;
    case "refs": {
      // matching-refs is not paged by GitHub; page it here so results stay bounded.
      const all = asArray(await read(["git", "matching-refs", parsed.refType ?? "tags",
        ...(parsed.prefix === undefined ? [] : [parsed.prefix])])).map(projectRef);
      const start = (page - 1) * perPage;
      items = all.slice(start, start + perPage);
      return result(kind, items, page, all.length > start + perPage);
    }
    case "workflow_runs": {
      const query: Record<string, string> = { ...paging };
      if (parsed.branch !== undefined) query.branch = parsed.branch;
      if (parsed.headSha !== undefined) query.head_sha = parsed.headSha;
      if (parsed.status !== undefined) query.status = parsed.status;
      if (parsed.event !== undefined) query.event = parsed.event;
      const resource = parsed.workflow === undefined
        ? ["actions", "runs"] : ["actions", "workflows", parsed.workflow, "runs"];
      items = asArray(asRecord(await read(resource, query)).workflow_runs).map(projectRun);
      break;
    }
    case "run_jobs":
      items = asArray(asRecord(await read(["actions", "runs", parsed.runId!, "jobs"], paging)).jobs)
        .map(projectJob);
      break;
    case "issues": {
      const query: Record<string, string> = { ...paging, state: parsed.state ?? "open" };
      if (parsed.labels !== undefined) query.labels = parsed.labels.join(",");
      items = asArray(await read(["issues"], query)).map((raw) => projectIssue(raw, LIST_BODY_CHARS));
      break;
    }
    case "issue":
      items = [projectIssue(asRecord(await read(["issues", parsed.number!])), DETAIL_BODY_CHARS)];
      paged = false;
      break;
    case "issue_comments":
      items = asArray(await read(["issues", parsed.number!, "comments"], paging)).map(projectComment);
      break;
    case "pull_request_reviews":
      items = asArray(await read(["pulls", parsed.number!, "reviews"], paging)).map(projectReview);
      break;
    case "pull_request_review_comments":
      items = asArray(await read(["pulls", parsed.number!, "comments"], paging)).map(projectReviewComment);
      break;
  }
  return result(kind, items, paged ? page : 1, paged && items.length === perPage);
}

/** Creates an issue or a comment on an issue or pull request. */
export async function writeGitHubIssue(
  client: GitHubApiClient,
  input: GitHubIssueWriteInput,
  context: OperationContext = {},
): Promise<GitHubIssueWriteResult> {
  const parsed = githubIssueWriteInputSchema.parse(input);
  if (!client.createRepositoryResource) throw unsupported();
  if (parsed.action === "create_issue") {
    const raw = asRecord(await client.createRepositoryResource(parsed.owner, parsed.repository, ["issues"], {
      title: parsed.title,
      body: parsed.body,
      ...(parsed.labels === undefined ? {} : { labels: parsed.labels }),
    }, context));
    return githubIssueWriteResultSchema.parse({
      status: "completed", action: "create_issue", number: raw.number, url: raw.html_url,
    });
  }
  const raw = asRecord(await client.createRepositoryResource(parsed.owner, parsed.repository,
    ["issues", parsed.number!, "comments"], { body: parsed.body }, context));
  return githubIssueWriteResultSchema.parse({
    status: "completed", action: "comment", number: parsed.number, url: raw.html_url, commentId: raw.id,
  });
}

function result(kind: GitHubReadResult["kind"], items: Item[], page: number, more: boolean): GitHubReadResult {
  return githubReadResultSchema.parse({ kind, items, page, ...(more ? { nextPage: page + 1 } : {}) });
}

function projectRelease(raw: Raw): Item {
  const assets = asArray(raw.assets).map((asset) =>
    `${str(asset.name) ?? "?"} (${num(asset.size) ?? 0} bytes, id ${num(asset.id) ?? 0})`);
  return {
    id: num(raw.id), tag: str(raw.tag_name), name: str(raw.name), draft: bool(raw.draft),
    prerelease: bool(raw.prerelease), targetCommitish: str(raw.target_commitish),
    publishedAt: str(raw.published_at), url: str(raw.html_url), assets,
  };
}

function projectRef(raw: Raw): Item {
  const object = asRecord(raw.object);
  return { ref: str(raw.ref), sha: str(object.sha), type: str(object.type) };
}

function projectRun(raw: Raw): Item {
  return {
    id: num(raw.id), name: str(raw.name), workflowPath: str(raw.path), event: str(raw.event),
    status: str(raw.status), conclusion: str(raw.conclusion), headBranch: str(raw.head_branch),
    headSha: str(raw.head_sha), runNumber: num(raw.run_number), runAttempt: num(raw.run_attempt),
    createdAt: str(raw.created_at), updatedAt: str(raw.updated_at), url: str(raw.html_url),
  };
}

function projectJob(raw: Raw): Item {
  const failedSteps = asArray(raw.steps)
    .filter((step) => step.conclusion === "failure")
    .map((step) => str(step.name) ?? "?");
  return {
    id: num(raw.id), name: str(raw.name), status: str(raw.status), conclusion: str(raw.conclusion),
    startedAt: str(raw.started_at), completedAt: str(raw.completed_at), url: str(raw.html_url),
    failedSteps,
  };
}

function projectIssue(raw: Raw, bodyChars: number): Item {
  const labels = asArray(raw.labels).map((label) => str(label.name) ?? "?");
  return {
    number: num(raw.number), title: str(raw.title), state: str(raw.state),
    author: str(asRecord(raw.user).login), labels, comments: num(raw.comments),
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
    createdAt: str(raw.created_at), updatedAt: str(raw.updated_at), url: str(raw.html_url),
    body: clip(raw.body, bodyChars),
  };
}

function projectComment(raw: Raw): Item {
  return {
    id: num(raw.id), author: str(asRecord(raw.user).login), createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at), url: str(raw.html_url), body: clip(raw.body, DETAIL_BODY_CHARS),
  };
}

function projectReview(raw: Raw): Item {
  return {
    id: num(raw.id), author: str(asRecord(raw.user).login), state: str(raw.state),
    submittedAt: str(raw.submitted_at), commitId: str(raw.commit_id), url: str(raw.html_url),
    body: clip(raw.body, DETAIL_BODY_CHARS),
  };
}

function projectReviewComment(raw: Raw): Item {
  return {
    id: num(raw.id), author: str(asRecord(raw.user).login), path: str(raw.path),
    line: num(raw.line), inReplyTo: num(raw.in_reply_to_id), createdAt: str(raw.created_at),
    url: str(raw.html_url), body: clip(raw.body, DETAIL_BODY_CHARS),
  };
}

function asRecord(value: unknown): Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
}

function asArray(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function unsupported(): AppError {
  return new AppError("CAPABILITY_UNSUPPORTED", "This GitHub client does not support typed reads.");
}
