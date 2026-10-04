import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { parse as parseYaml } from "yaml";
import {
  executeOAuthReprovision,
  OAUTH_REPROVISION_CONFIRMATION,
  preflightOAuthReprovision,
} from "../../../../tooling/update-control-oauth-reprovision.mjs";

const OPERATION_ID = "ed1c5642-04aa-4e4d-8558-8aefc4f673c7";
const OWNER_TOKEN = "replacement-owner-secret-long-random-test-value";
const ACCESS_ID = "access-client-id-test";
const ACCESS_SECRET = "access-client-secret-test";
const OAUTH_URL = "https://update-control-ops.example/_operations/oauth/reprovision";

function makeEnv(overrides = {}) {
  return {
    UPDATE_CONTROL_OAUTH_CONFIRM: OAUTH_REPROVISION_CONFIRMATION,
    UPDATE_CONTROL_OAUTH_OPERATION_ID: OPERATION_ID,
    UPDATE_CONTROL_OAUTH_REPROVISION_URL: OAUTH_URL,
    UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_ID: ACCESS_ID,
    UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
    UPDATE_CONTROL_OWNER_TOKEN_NEXT: OWNER_TOKEN,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseWorkflow(name) {
  return readFile(new URL(`../../../../.github/workflows/${name}`, import.meta.url), "utf8")
    .then((source) => parseYaml(source));
}

function findStep(workflow, jobName, stepName) {
  const step = workflow.jobs[jobName].steps.find(({ name }) => name === stepName);
  expect(step).toBeDefined();
  return step;
}

describe("Update Control OAuth reprovision operator workflow", () => {
  it("keeps normal Worker deploy manual, protected, main-only, and disconnected from Edge/public release", async () => {
    const workflow = await parseWorkflow("update-control-deploy.yml");
    expect(workflow.on.pull_request.branches).toEqual(["main"]);
    expect(workflow.on.workflow_dispatch.inputs.confirm_deploy.default).toBe("NO");
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.jobs.validate.if).toContain("pull_request");
    expect(workflow.jobs.deploy.if).toContain("workflow_dispatch");
    expect(workflow.jobs.deploy.if).toContain("refs/heads/main");
    expect(workflow.jobs.deploy.environment.name).toBe("update-control-production");
    const deploy = findStep(workflow, "deploy", "Deploy only Update Control");
    expect(deploy.run).toContain("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler deploy");
    expect(deploy.run).toContain("UPDATE_CONTROL_CF_API_TOKEN");
    expect(deploy.run).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(deploy.run).toContain("UPDATE_CONTROL_OAUTH_REPROVISION_URL");
    expect(deploy.run).toContain("MCP_UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_ISSUER");
    expect(deploy.run).toContain("MCP_UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE");
    expect(deploy.env.UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_ISSUER).toContain("vars.");
    expect(deploy.env.UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE).toContain("vars.");
    expect(deploy.run).not.toMatch(/public-release|edge-breakglass|mcp-edge-gateway/iu);
  });

  it("keeps OAuth reprovision dispatch-only, protected, explicitly confirmed, and bounded to fixed operations", async () => {
    const workflow = await parseWorkflow("update-control-oauth-reprovision.yml");
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.confirm_reprovision.default).toBe("NO");
    expect(workflow.jobs.reprovision.if).toContain("refs/heads/main");
    expect(workflow.jobs.reprovision.if).toContain("REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS");
    expect(workflow.jobs.reprovision.environment.name).toBe("update-control-production");
    expect(workflow.jobs.reprovision.permissions).toEqual({ contents: "read" });

    const replaceSecret = findStep(workflow, "reprovision", "Install replacement owner token through locked Wrangler");
    expect(replaceSecret.run).toContain(`printf '%s' "$UPDATE_CONTROL_OWNER_TOKEN_NEXT" |`);

    expect(replaceSecret.run).toContain("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler secret put MCP_OWNER_TOKEN");
    expect(replaceSecret.run).not.toContain(`echo "$UPDATE_CONTROL_OWNER_TOKEN_NEXT"`);

    expect(findStep(workflow, "reprovision", "Check operation status through Cloudflare Access").run)
      .toContain("tooling/update-control-oauth-reprovision.mjs preflight");
    expect(findStep(workflow, "reprovision", "Reconcile the same operation ID through Cloudflare Access").run)
      .toContain("tooling/update-control-oauth-reprovision.mjs apply");

    const triggerNames = Object.keys(workflow.on);
    expect(triggerNames).not.toContain("push");
    expect(triggerNames).not.toContain("pull_request");
  });
});

describe("OAuth reprovision operator client", () => {
  it("checks completed status without requiring or changing a replacement token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-control-oauth-"));
    try {
      const outputPath = join(dir, "github-output");
      const env = makeEnv({ GITHUB_OUTPUT: outputPath, UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" });
      const requests = [];
      const result = await preflightOAuthReprovision({
        env,
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init });
          return jsonResponse({ operationId: OPERATION_ID, status: "completed", events: [] });
        },
      });
      expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
      expect(requests).toHaveLength(1);
      expect(requests[0].init.method).toBe("GET");
      expect(requests[0].url).toContain(`operationId=${OPERATION_ID}`);
      expect(requests[0].init.headers["CF-Access-Client-Id"]).toBe(ACCESS_ID);
      expect(requests[0].init.headers["CF-Access-Client-Secret"]).toBe(ACCESS_SECRET);
      expect(await readFile(outputPath, "utf8")).toContain("completed=true");
      expect(await readFile(outputPath, "utf8")).not.toContain(OWNER_TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an active operation conflict before the secret-change step", async () => {
    let calls = 0;
    await expect(preflightOAuthReprovision({
      env: makeEnv(),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "another_operation_active" }, 409);
      },
    })).rejects.toThrow("different OAuth reprovision is active");
    expect(calls).toBe(1);
  });

  it("resumes only the same operation ID and polls bounded in-progress batches to completion", async () => {
    const requests = [];
    const responses = [
      jsonResponse({ operationId: OPERATION_ID, status: "in_progress" }),
      jsonResponse({ operationId: OPERATION_ID, status: "in_progress", attempt: 2 }, 202),
      jsonResponse({ operationId: OPERATION_ID, status: "completed", attempt: 3 }),
    ];
    const result = await executeOAuthReprovision({
      env: makeEnv(),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift();
      },
      sleep: async () => undefined,
    });
    expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "POST"]);
    expect(requests[1].init.body).toBe(JSON.stringify({ operationId: OPERATION_ID }));
    expect(requests[2].init.body).toBe(JSON.stringify({ operationId: OPERATION_ID }));
    expect(JSON.stringify(requests)).not.toContain(OWNER_TOKEN);
  });

  it("stops on outcome_unknown without retrying or logging the owner token", async () => {
    const requests = [];
    await expect(executeOAuthReprovision({
      env: makeEnv(),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init.method === "GET") {
          return jsonResponse({ operationId: OPERATION_ID, status: "in_progress" });
        }
        return jsonResponse({ operationId: OPERATION_ID, status: "outcome_unknown" }, 503);
      },
    })).rejects.toThrow("outcome_unknown");
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    expect(JSON.stringify(requests)).not.toContain(OWNER_TOKEN);
  });

  it("rejects non-HTTPS, wrong-path, and unconfirmed requests before network access", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ operationId: OPERATION_ID, status: "not_executed" });
    };
    await expect(preflightOAuthReprovision({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_REPROVISION_URL: "http://ops.example/_operations/oauth/reprovision" }),
      fetchImpl,
    })).rejects.toThrow("HTTPS");
    await expect(preflightOAuthReprovision({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_REPROVISION_URL: "https://ops.example/admin/reset" }),
      fetchImpl,
    })).rejects.toThrow("fixed operations path");
    await expect(preflightOAuthReprovision({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "NO" }),
      fetchImpl,
    })).rejects.toThrow("Explicit OAuth reprovision confirmation");
    expect(calls).toBe(0);
  });

  it("enforces a small response limit", async () => {
    const oversized = new Response("x".repeat(16 * 1024 + 1), { status: 200 });
    await expect(preflightOAuthReprovision({
      env: makeEnv(),
      fetchImpl: async () => oversized,
    })).rejects.toThrow("size limit");
  });
});
