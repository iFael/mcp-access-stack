import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { parse as parseYaml } from "yaml";
import {
  createTestGitHubActionsAssertion,
  testGitHubActionsJwksFetch,
} from "./github-actions-oidc-fixture.js";
import {
  diagnoseOAuthReprovisionStatus,
  executeOAuthReprovision,
  OAUTH_REPROVISION_CONFIRMATION,
  preflightOAuthReprovision,
} from "../../../../tooling/update-control-oauth-reprovision.mjs";

const OPERATION_ID = "ed1c5642-04aa-4e4d-8558-8aefc4f673c7";
const OWNER_TOKEN = "replacement-owner-secret-long-random-test-value";
const OIDC_REQUEST_URL = "https://pipelinesghubeus7.actions.githubusercontent.com/synthetic-run/idtoken?api-version=2.0";
const OIDC_REQUEST_TOKEN = "synthetic-runner-request-token";
const OIDC_ASSERTION = "synthetic-github-oidc-assertion";
const PUBLIC_URL = "https://mcp-v3-update-control.example.workers.dev/";

function makeEnv(overrides = {}) {
  return {
    UPDATE_CONTROL_OAUTH_CONFIRM: OAUTH_REPROVISION_CONFIRMATION,
    UPDATE_CONTROL_OAUTH_OPERATION_ID: OPERATION_ID,
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
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

function makeOidcFetch(operationFetch, oidcRequests = []) {
  return async (url, init) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
      oidcRequests.push({ url: requestUrl, init });
      return jsonResponse({ value: OIDC_ASSERTION });
    }
    return operationFetch(requestUrl, init);
  };
}

describe("Update Control OAuth reprovision operator workflow", () => {
  it("keeps normal Worker deploy manual, protected, fail-closed, and isolated from OAuth operations and Edge", async () => {
    const workflow = await parseWorkflow("update-control-deploy.yml");
    expect(workflow.on.pull_request.branches).toEqual(["main"]);
    expect(workflow.on.workflow_dispatch.inputs.confirm_deploy.default).toBe("NO");
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.jobs.validate.if).toContain("pull_request");
    expect(workflow.jobs.deploy.if).toContain("workflow_dispatch");
    expect(workflow.jobs.deploy.if).toContain("refs/heads/main");
    expect(workflow.jobs.deploy.environment.name).toBe("update-control-production");

    const preflight = findStep(workflow, "deploy", "Validate all normal-deploy runtime settings without printing values");
    const deploy = findStep(workflow, "deploy", "Deploy only Update Control");
    const installSecrets = findStep(workflow, "deploy", "Install Oracle WSS channel secret through locked Wrangler stdin");
    const steps = workflow.jobs.deploy.steps;
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(installSecrets));
    expect(steps.indexOf(installSecrets)).toBeLessThan(steps.indexOf(deploy));
    expect(steps.at(-1)).toBe(deploy);
    expect(preflight.run).toBe("node tooling/update-control-deploy-preflight.mjs");

    const preflightSources = {
      UPDATE_CONTROL_CF_API_TOKEN: "secrets.UPDATE_CONTROL_CF_API_TOKEN",
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: "secrets.UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN",
      CLOUDFLARE_ACCOUNT_ID: "vars.CLOUDFLARE_ACCOUNT_ID",
      MCP_UPDATE_CONTROL_PUBLIC_URL: "vars.MCP_UPDATE_CONTROL_PUBLIC_URL",
    };
    for (const [name, source] of Object.entries(preflightSources)) {
      expect(preflight.env[name]).toBe("${{ " + source + " }}");
    }

    expect(deploy.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.UPDATE_CONTROL_CF_API_TOKEN }}");
    expect(deploy.run).toContain("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler deploy");
    expect(deploy.run.indexOf("wrangler deploy")).toBeGreaterThanOrEqual(0);
    expect(deploy.run).toContain("MCP_UPDATE_CONTROL_PUBLIC_URL:$MCP_UPDATE_CONTROL_PUBLIC_URL");
    expect(deploy.run).not.toMatch(/ORACLE_ACCESS_CLIENT|ORCHESTRATOR_READ_API_URL|UPDATE_CONTROL_OAUTH_REPROVISION|cloudflared|tunnel/iu);
    expect(deploy.env.MCP_UPDATE_CONTROL_PUBLIC_URL).toBe("${{ vars.MCP_UPDATE_CONTROL_PUBLIC_URL }}");
    expect(deploy.run).not.toMatch(/UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_ID|UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_SECRET|UPDATE_CONTROL_OWNER_TOKEN_NEXT|MCP_OWNER_TOKEN|public-release|edge-breakglass|mcp-edge-gateway/iu);

    expect(installSecrets.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.UPDATE_CONTROL_CF_API_TOKEN }}");
    expect(installSecrets.env.CLOUDFLARE_ACCOUNT_ID).toBe("${{ vars.CLOUDFLARE_ACCOUNT_ID }}");
    expect(installSecrets.env.UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN).toBe("${{ secrets.UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN }}");
    expect(installSecrets.run).toContain("wrangler secret put UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN");
    expect(installSecrets.run).toContain('printf \'%s\' "$UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN" |');
    expect(installSecrets.run).not.toMatch(/echo\s+.*UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN/u);
    expect(workflow.jobs.validate.environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.validate)).not.toMatch(/secrets\.|vars\./u);
  });

  it("keeps OAuth reprovision dispatch-only, protected, explicitly confirmed, and bounded to fixed operations", async () => {
    const workflow = await parseWorkflow("update-control-oauth-reprovision.yml");
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.confirm_reprovision.default).toBe("NO");
    expect(workflow.on.workflow_dispatch.inputs.confirm_reprovision.options)
      .toEqual(["NO", "DIAGNOSE_STATUS", "REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS"]);
    expect(workflow.jobs.reprovision.if).toContain("refs/heads/main");
    expect(workflow.jobs.reprovision.if).toContain("REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS");
    expect(workflow.jobs.reprovision.environment.name).toBe("update-control-production");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.reprovision.permissions).toEqual({ contents: "read", "id-token": "write" });

    const replaceSecret = findStep(workflow, "reprovision", "Install replacement owner token through locked Wrangler");
    expect(replaceSecret.run).toContain(`printf '%s' "$UPDATE_CONTROL_OWNER_TOKEN_NEXT" |`);

    expect(replaceSecret.run).toContain("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler secret put MCP_OWNER_TOKEN");
    expect(replaceSecret.run).not.toContain(`echo "$UPDATE_CONTROL_OWNER_TOKEN_NEXT"`);

    const preflight = findStep(workflow, "reprovision", "Check operation status with operation-bound GitHub OIDC");
    const reconcile = findStep(workflow, "reprovision", "Reconcile the same operation ID with GitHub OIDC");
    expect(preflight.run).toContain("tooling/update-control-oauth-reprovision.mjs preflight");
    expect(reconcile.run).toContain("tooling/update-control-oauth-reprovision.mjs apply");
    expect(JSON.stringify([preflight.env, reconcile.env])).not.toMatch(/CLOUDFLARE.*ACCESS|UPDATE_CONTROL_OAUTH_ACCESS/iu);
    expect(JSON.stringify(workflow.jobs.reprovision)).not.toMatch(/CF-Access|cloudflareaccess/iu);

    const diagnose = workflow.jobs.diagnose;
    expect(diagnose.if).toContain("DIAGNOSE_STATUS");
    expect(diagnose.if).not.toContain("REPROVISION_OAUTH_AND_INVALIDATE_ALL_SESSIONS");
    expect(diagnose.environment.name).toBe("update-control-production");
    expect(diagnose.permissions).toEqual({ contents: "read", "id-token": "write" });
    const diagnoseStep = findStep(workflow, "diagnose", "Diagnose operation status with operation-bound GitHub OIDC");
    expect(diagnoseStep.run).toBe("node tooling/update-control-oauth-reprovision.mjs diagnose");
    expect(diagnoseStep.env.UPDATE_CONTROL_OAUTH_OPERATION_ID).toBe("${{ inputs.operation_id }}");
    expect(diagnoseStep.env.MCP_UPDATE_CONTROL_PUBLIC_URL).toBe("${{ vars.MCP_UPDATE_CONTROL_PUBLIC_URL }}");
    const serializedDiagnose = JSON.stringify(diagnose);
    expect(serializedDiagnose).not.toMatch(/secrets\.|UPDATE_CONTROL_OWNER_TOKEN_NEXT|MCP_OWNER_TOKEN|CLOUDFLARE|wrangler|\bapply\b/iu);

    const triggerNames = Object.keys(workflow.on);
    expect(triggerNames).not.toContain("push");
    expect(triggerNames).not.toContain("pull_request");
  });
});

describe("OAuth reprovision operator client", () => {
  it("diagnoses the GET status response without destructive confirmation or secret material", async () => {
    const assertion = await createTestGitHubActionsAssertion(OPERATION_ID);
    const requests = [];
    const result = await diagnoseOAuthReprovisionStatus({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "", UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" }),
      fetchImpl: async (url, init) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.hostname === "token.actions.githubusercontent.com") {
          return testGitHubActionsJwksFetch(requestUrl);
        }
        if (requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
          return jsonResponse({ value: assertion });
        }
        requests.push({ url: requestUrl, init });
        return jsonResponse({
          error: "operation_auth_required",
          diagnosticStage: "jwks_fetch",
          diagnosticFailureCategory: "fetch_rejected",
          diagnosticRejectionClass: "type_error",
          diagnosticTypeErrorReason: "network_connection_lost",
        }, 401);
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].init.method).toBe("GET");
    expect(requests[0].init.headers["x-update-control-oidc-diagnose"]).toBe("v1");
    expect(result.httpStatus).toBe(401);
    expect(result.status).toBeNull();
    expect(result.error).toBe("operation_auth_required");
    expect(result.workerStage).toBe("jwks_fetch");
    expect(result.workerFailureCategory).toBe("fetch_rejected");
    expect(result.workerRejectionClass).toBe("type_error");
    expect(result.workerTypeErrorReason).toBe("network_connection_lost");
    expect(result.assertion).toEqual({
      formatValid: true,
      algMatches: true,
      kidPresent: true,
      headerGuardsMatch: true,
      jwksFetchOk: true,
      jwksShapeValid: true,
      kidInJwks: true,
      keyImportValid: true,
      signatureValid: true,
      issuerMatches: true,
      audienceMatches: true,
      subjectMatches: true,
      repositoryMatches: true,
      repositoryOwnerIdMatches: true,
      repositoryIdMatches: true,
      workflowRefMatches: true,
      refMatches: true,
      eventNameMatches: true,
      environmentMatches: true,
      jtiPresent: true,
      issuedAtPresent: true,
      notBeforePresent: true,
      expiresAtPresent: true,
      issuedAtFresh: true,
      notBeforeValid: true,
      notExpired: true,
      lifetimeValid: true,
      temporalOrderValid: true,
    });
    expect(JSON.stringify(result)).not.toContain(assertion);
    expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
  });

  it.each([
    ["unknown fallback", "unknown_type_error", "type_error", "unknown_type_error"],
    ["unrecognized reason", "raw-reason-sentinel", "type_error", null],
    ["reason outside TypeError class", "network_connection_lost", "error", null],
  ])("accepts only closed TypeError reasons: %s", async (_label, reason, rejectionClass, expectedReason) => {
    const assertion = await createTestGitHubActionsAssertion(OPERATION_ID);
    const rawMessage = "raw-message-sentinel";
    const rawStack = "raw-stack-sentinel";
    const rawCause = "raw-cause-sentinel";
    const result = await diagnoseOAuthReprovisionStatus({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "", UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" }),
      fetchImpl: async (url) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.hostname === "token.actions.githubusercontent.com") {
          return testGitHubActionsJwksFetch(requestUrl);
        }
        if (requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
          return jsonResponse({ value: assertion });
        }
        return jsonResponse({
          error: "operation_auth_required",
          diagnosticStage: "jwks_fetch",
          diagnosticFailureCategory: "fetch_rejected",
          diagnosticRejectionClass: rejectionClass,
          diagnosticTypeErrorReason: reason,
          message: rawMessage,
          stack: rawStack,
          cause: rawCause,
        }, 401);
      },
    });
    expect(result.workerTypeErrorReason).toBe(expectedReason);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawMessage);
    expect(serialized).not.toContain(rawStack);
    expect(serialized).not.toContain(rawCause);
    expect(serialized).not.toContain("raw-reason-sentinel");
  });

  it("drops an unrecognized Worker fetch failure category", async () => {
    const assertion = await createTestGitHubActionsAssertion(OPERATION_ID);
    const result = await diagnoseOAuthReprovisionStatus({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "", UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" }),
      fetchImpl: async (url) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.hostname === "token.actions.githubusercontent.com") {
          return testGitHubActionsJwksFetch(requestUrl);
        }
        if (requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
          return jsonResponse({ value: assertion });
        }
        return jsonResponse({
          error: "operation_auth_required",
          diagnosticStage: "jwks_fetch",
          diagnosticFailureCategory: "unrecognized-category",
        }, 401);
      },
    });
    expect(result.workerStage).toBe("jwks_fetch");
    expect(result.workerFailureCategory).toBeNull();
    expect(result.workerRejectionClass).toBeNull();
    expect(JSON.stringify(result)).not.toContain("unrecognized-category");
  });

  it("drops an unrecognized Worker fetch rejection class while preserving the valid category", async () => {
    const assertion = await createTestGitHubActionsAssertion(OPERATION_ID);
    const result = await diagnoseOAuthReprovisionStatus({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "", UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" }),
      fetchImpl: async (url) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.hostname === "token.actions.githubusercontent.com") {
          return testGitHubActionsJwksFetch(requestUrl);
        }
        if (requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
          return jsonResponse({ value: assertion });
        }
        return jsonResponse({
          error: "operation_auth_required",
          diagnosticStage: "jwks_fetch",
          diagnosticFailureCategory: "fetch_rejected",
          diagnosticRejectionClass: "unrecognized-class",
        }, 401);
      },
    });
    expect(result.workerStage).toBe("jwks_fetch");
    expect(result.workerFailureCategory).toBe("fetch_rejected");
    expect(result.workerRejectionClass).toBeNull();
    expect(JSON.stringify(result)).not.toContain("unrecognized-class");
  });

  it("requests a UUID-bound GitHub OIDC token and checks completed status without a replacement token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-control-oauth-"));
    try {
      const outputPath = join(dir, "github-output");
      const env = makeEnv({ GITHUB_OUTPUT: outputPath, UPDATE_CONTROL_OWNER_TOKEN_NEXT: "" });
      const requests = [];
      const oidcRequests = [];
      const result = await preflightOAuthReprovision({
        env,
        fetchImpl: makeOidcFetch(async (url, init) => {
          requests.push({ url: String(url), init });
          return jsonResponse({ operationId: OPERATION_ID, status: "completed", events: [] });
        }, oidcRequests),
      });
      expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
      expect(oidcRequests).toHaveLength(1);
      expect(oidcRequests[0].init.method).toBe("GET");
      expect(oidcRequests[0].init.headers.authorization).toBe(`Bearer ${OIDC_REQUEST_TOKEN}`);
      expect(oidcRequests[0].url.searchParams.get("audience"))
        .toBe(`urn:mcp-v3-update-control:oauth-reprovision:${OPERATION_ID}`);
      expect(requests).toHaveLength(1);
      expect(requests[0].init.method).toBe("GET");
      expect(requests[0].url).toContain(`operationId=${OPERATION_ID}`);
      expect(new URL(requests[0].url).origin).toBe(new URL(PUBLIC_URL).origin);
      expect(new URL(requests[0].url).pathname).toBe("/_operations/oauth/reprovision");
      expect(requests[0].init.headers.authorization).toBe(`Bearer ${OIDC_ASSERTION}`);
      expect(requests[0].init.headers["x-update-control-oidc-diagnose"]).toBeUndefined();
      expect(requests[0].init.headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(requests[0].init.headers["CF-Access-Client-Secret"]).toBeUndefined();
      expect(await readFile(outputPath, "utf8")).toContain("completed=true");
      expect(await readFile(outputPath, "utf8")).not.toContain(OWNER_TOKEN);
      expect(JSON.stringify(oidcRequests)).not.toContain(OWNER_TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an active operation conflict before the secret-change step", async () => {
    const requests = [];
    const oidcRequests = [];
    await expect(preflightOAuthReprovision({
      env: makeEnv(),
      fetchImpl: makeOidcFetch(async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ error: "another_operation_active" }, 409);
      }, oidcRequests),
    })).rejects.toThrow("different OAuth reprovision is active");
    expect(requests).toHaveLength(1);
    expect(oidcRequests).toHaveLength(1);
  });

  it("resumes only the same operation ID and polls bounded in-progress batches to completion", async () => {
    const requests = [];
    const oidcRequests = [];
    const responses = [
      jsonResponse({ operationId: OPERATION_ID, status: "in_progress" }),
      jsonResponse({ operationId: OPERATION_ID, status: "in_progress", attempt: 2 }, 202),
      jsonResponse({ operationId: OPERATION_ID, status: "completed", attempt: 3 }),
    ];
    const result = await executeOAuthReprovision({
      env: makeEnv(),
      fetchImpl: makeOidcFetch(async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift();
      }, oidcRequests),
      sleep: async () => undefined,
    });
    expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "POST"]);
    expect(requests.every(({ init }) =>
      init.headers["x-update-control-oidc-diagnose"] === undefined)).toBe(true);
    expect(requests[1].init.body).toBe(JSON.stringify({ operationId: OPERATION_ID }));
    expect(requests[2].init.body).toBe(JSON.stringify({ operationId: OPERATION_ID }));
    expect(requests.every(({ init }) => init.headers.authorization === `Bearer ${OIDC_ASSERTION}`)).toBe(true);
    expect(oidcRequests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(OWNER_TOKEN);
  });

  it("stops on outcome_unknown without retrying or logging the owner token", async () => {
    const requests = [];
    const oidcRequests = [];
    await expect(executeOAuthReprovision({
      env: makeEnv(),
      fetchImpl: makeOidcFetch(async (url, init) => {
        requests.push({ url: String(url), init });
        if (init.method === "GET") {
          return jsonResponse({ operationId: OPERATION_ID, status: "in_progress" });
        }
        return jsonResponse({ operationId: OPERATION_ID, status: "outcome_unknown" }, 503);
      }, oidcRequests),
    })).rejects.toThrow("outcome_unknown");
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    expect(oidcRequests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(OWNER_TOKEN);
  });

  it("rejects invalid public origins, unconfirmed operations, and untrusted OIDC request URLs before network access", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ operationId: OPERATION_ID, status: "not_executed" });
    };
    await expect(preflightOAuthReprovision({
      env: makeEnv({ MCP_UPDATE_CONTROL_PUBLIC_URL: "http://mcp-v3-update-control.example.workers.dev/" }),
      fetchImpl,
    })).rejects.toThrow("HTTPS");
    for (const value of [
      "https://mcp-v3-update-control.example.workers.dev/nested",
      "https://mcp-v3-update-control.example.workers.dev/?unexpected=1",
      "https://mcp-v3-update-control.example.workers.dev/#unexpected",
      "https://mcp-v3-update-control.example.workers.dev/../",
      "https://user@mcp-v3-update-control.example.workers.dev/",
      "https://mcp-v3-update-control.example.workers.dev:8443/",
      "not a URL",
    ]) {
      await expect(preflightOAuthReprovision({
        env: makeEnv({ MCP_UPDATE_CONTROL_PUBLIC_URL: value }),
        fetchImpl,
      })).rejects.toThrow("public URL");
    }
    await expect(preflightOAuthReprovision({
      env: makeEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: "NO" }),
      fetchImpl,
    })).rejects.toThrow("Explicit OAuth reprovision confirmation");
    await expect(preflightOAuthReprovision({
      env: makeEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/token" }),
      fetchImpl,
    })).rejects.toThrow("OIDC request endpoint is invalid");
    await expect(preflightOAuthReprovision({
      env: makeEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelinesghubeus7.actions.githubusercontent.com.attacker.example/token" }),
      fetchImpl,
    })).rejects.toThrow("OIDC request endpoint is invalid");
    await expect(preflightOAuthReprovision({
      env: makeEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelinesghubeus7.actions.githubusercontent.com:8443/synthetic-run/idtoken" }),
      fetchImpl,
    })).rejects.toThrow("OIDC request endpoint is invalid");
    expect(calls).toBe(0);
  });

  it("enforces a small response limit", async () => {
    const oversized = new Response("x".repeat(16 * 1024 + 1), { status: 200 });
    await expect(preflightOAuthReprovision({
      env: makeEnv(),
      fetchImpl: makeOidcFetch(async () => oversized),
    })).rejects.toThrow("size limit");
  });
});
