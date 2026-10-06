import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  diagnoseOAuthReprovisionStatus,
  executeOAuthReprovision,
  OAUTH_REPROVISION_CONFIRMATION,
  preflightOAuthReprovision,
  waitForOAuthReprovisionReadiness,
} from "../../../../tooling/update-control-oauth-reprovision.mjs";

const OPERATION_ID = "b795a30e-90d3-4a51-95ed-3c06bbc1e2ad";
const PUBLIC_URL = "https://mcp-v3-update-control.example.workers.dev";
const HMAC_KEY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
const OWNER_TOKEN = "replacement-owner-token-with-more-than-thirty-two-characters";
const SIGNATURE_DOMAIN = "mcp-v3-update-control:oauth-reprovision";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    UPDATE_CONTROL_OAUTH_CONFIRM: OAUTH_REPROVISION_CONFIRMATION,
    UPDATE_CONTROL_OAUTH_OPERATION_ID: OPERATION_ID,
    UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY: HMAC_KEY,
    UPDATE_CONTROL_OWNER_TOKEN_NEXT: OWNER_TOKEN,
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeHex(value) {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function expectValidSignature(url, method, authorization, operationId) {
  const match = /^HMAC-SHA256 v1=(0|[1-9][0-9]{0,11})\.([0-9a-f]{64})$/u.exec(authorization);
  expect(match).not.toBeNull();
  const timestamp = match[1];
  expect(Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))).toBeLessThanOrEqual(300);
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(HMAC_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const canonical = [
    SIGNATURE_DOMAIN,
    "v1",
    method,
    new URL(url).pathname,
    operationId,
    timestamp,
  ].join("\n");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(match[2]),
    new TextEncoder().encode(canonical),
  );
  expect(valid).toBe(true);
}

function workflow(path: string) {
  return parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

describe("controlled Update Control OAuth reprovision", () => {
  it("keeps the reprovision workflow manually gated and uses only the operation HMAC credential", () => {
    const definition = workflow("../../../../.github/workflows/update-control-oauth-reprovision.yml");
    const reprovisionOptions = definition.on.workflow_dispatch.inputs.confirm_reprovision.options;

    expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
    expect(reprovisionOptions).toEqual([
      "NO",
      "DIAGNOSE_STATUS",
      OAUTH_REPROVISION_CONFIRMATION,
    ]);
    expect(definition.concurrency).toEqual({
      group: "update-control-production",
      "cancel-in-progress": false,
    });
    expect(definition.jobs.diagnose.environment.name).toBe("update-control-production");
    expect(definition.jobs.reprovision.environment.name).toBe("update-control-production");
    expect(definition.jobs.diagnose.permissions).toEqual({ contents: "read" });
    expect(definition.jobs.reprovision.permissions).toEqual({ contents: "read" });
    expect(definition.jobs.diagnose.if).toContain("refs/heads/main");
    expect(definition.jobs.reprovision.if).toContain("refs/heads/main");
    expect(JSON.stringify(definition)).not.toContain("id-token");

    const diagnose = definition.jobs.diagnose.steps.find((step) => step.run?.includes(" diagnose"));
    const preflight = definition.jobs.reprovision.steps.find((step) => step.id === "preflight");
    const reconcile = definition.jobs.reprovision.steps.find((step) => step.run?.includes(" apply"));
    const installOwner = definition.jobs.reprovision.steps.find((step) => step.name.includes("replacement owner token"));
    const waitReady = definition.jobs.reprovision.steps.find((step) => step.run?.includes(" wait-ready"));

    expect(diagnose.env.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY)
      .toBe("${{ secrets.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY }}");
    expect(preflight.env.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY)
      .toBe("${{ secrets.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY }}");
    expect(reconcile.env.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY)
      .toBe("${{ secrets.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY }}");
    expect(preflight.env.UPDATE_CONTROL_OAUTH_OPERATION_ID).toBe("${{ inputs.operation_id }}");
    expect(reconcile.env.UPDATE_CONTROL_OAUTH_OPERATION_ID).toBe("${{ inputs.operation_id }}");
    expect(installOwner.if).toContain("steps.preflight.outputs.completed != 'true'");
    expect(installOwner.run).toContain("wrangler secret put MCP_OWNER_TOKEN");
    expect(installOwner.run).toContain("printf '%s'");
    expect(installOwner.run).not.toContain("echo \"$UPDATE_CONTROL_OWNER_TOKEN_NEXT\"");
    expect(waitReady.if).toContain("steps.preflight.outputs.completed != 'true'");
    expect(waitReady.env).toEqual({ MCP_UPDATE_CONTROL_PUBLIC_URL: "${{ vars.MCP_UPDATE_CONTROL_PUBLIC_URL }}" });
    expect(definition.jobs.reprovision.steps.indexOf(installOwner)).toBeLessThan(definition.jobs.reprovision.steps.indexOf(waitReady));
    expect(definition.jobs.reprovision.steps.indexOf(waitReady)).toBeLessThan(definition.jobs.reprovision.steps.indexOf(reconcile));
  });

  it("preflights and installs the dedicated HMAC key only in the normal manual deployment workflow", () => {
    const definition = workflow("../../../../.github/workflows/update-control-deploy.yml");
    const deploy = definition.jobs.deploy;
    const preflight = deploy.steps.find((step) => step.run?.includes("update-control-deploy-preflight"));
    const installHmac = deploy.steps.find((step) => step.name.includes("OAuth reprovision HMAC key"));
    const installOracle = deploy.steps.find((step) => step.name.includes("Oracle WSS channel secret"));
    const deployWorker = deploy.steps.find((step) => step.name === "Deploy only Update Control");

    expect(Object.keys(definition.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(definition.concurrency.group).toBe("update-control-production");
    expect(definition.on.workflow_dispatch.inputs.confirm_deploy.options).toEqual(["NO", "DEPLOY_UPDATE_CONTROL"]);
    expect(deploy.if).toContain("refs/heads/main");
    expect(deploy.if).toContain("DEPLOY_UPDATE_CONTROL");
    expect(deploy.environment.name).toBe("update-control-production");
    expect(preflight.env.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY)
      .toBe("${{ secrets.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY }}");
    expect(installHmac.env.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY)
      .toBe("${{ secrets.UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY }}");
    expect(installHmac.run).toContain("printf '%s'");
    expect(installHmac.run).toContain("wrangler secret put UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY");
    expect(deploy.steps.indexOf(preflight)).toBeLessThan(deploy.steps.indexOf(installOracle));
    expect(deploy.steps.indexOf(installOracle)).toBeLessThan(deploy.steps.indexOf(installHmac));
    expect(deploy.steps.indexOf(installHmac)).toBeLessThan(deploy.steps.indexOf(deployWorker));
    expect(JSON.stringify(installHmac.run)).not.toContain("UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN");
    expect(JSON.stringify(installHmac.run)).not.toContain("MCP_OWNER_TOKEN");
    expect(JSON.stringify(installHmac.run)).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
  });

  it("diagnoses status with a signed GET without requiring the destructive confirmation or owner token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await diagnoseOAuthReprovisionStatus({
      env: validEnv({
        UPDATE_CONTROL_OAUTH_CONFIRM: undefined,
        UPDATE_CONTROL_OWNER_TOKEN_NEXT: undefined,
      }),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ operationId: OPERATION_ID, status: "completed" });
      },
    });

    expect(result).toEqual({
      operationId: OPERATION_ID,
      httpStatus: 200,
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/_operations/oauth/reprovision");
    expect(new URL(requests[0].url).searchParams.get("operationId")).toBe(OPERATION_ID);
    expect(requests[0].init.method).toBe("GET");
    await expectValidSignature(
      requests[0].url,
      requests[0].init.method,
      requests[0].init.headers.authorization,
      OPERATION_ID,
    );
    expect(JSON.stringify(result)).not.toContain(HMAC_KEY);
  });

  it("allows completed status preflight without the replacement owner token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await preflightOAuthReprovision({
      env: validEnv({ UPDATE_CONTROL_OWNER_TOKEN_NEXT: undefined }),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({ operationId: OPERATION_ID, status: "completed" });
      },
    });

    expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
    expect(requests).toHaveLength(1);
    await expectValidSignature(
      requests[0].url,
      requests[0].init.method,
      requests[0].init.headers.authorization,
      OPERATION_ID,
    );
  });

  it("waits boundedly for the replacement owner token runtime to become ready without secrets", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      jsonResponse({ error: "update_control_not_configured" }, 503),
      jsonResponse({ error: "oauth_reprovision_required" }, 503),
    ];
    const result = await waitForOAuthReprovisionReadiness({
      env: { MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift();
      },
      sleep: async () => {},
      maxAttempts: 3,
    });

    expect(result).toEqual({ state: "oauth_reprovision_required" });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => new URL(url).pathname === "/mcp")).toBe(true);
    expect(requests.every(({ init }) => init.method === "GET")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(HMAC_KEY);
    expect(JSON.stringify(requests)).not.toContain(OWNER_TOKEN);
  });

  it("signs status and apply requests for the same operation ID and resumes only in_progress", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const postResponses = [
      jsonResponse({ operationId: OPERATION_ID, status: "in_progress" }, 202),
      jsonResponse({ operationId: OPERATION_ID, status: "completed" }, 200),
    ];
    const result = await executeOAuthReprovision({
      env: validEnv(),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init.method === "GET") return jsonResponse({ operationId: OPERATION_ID, status: "in_progress" });
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ operationId: OPERATION_ID });
        return postResponses.shift();
      },
      sleep: async () => {},
    });

    expect(result).toEqual({ operationId: OPERATION_ID, status: "completed" });
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "POST"]);
    for (const request of requests) {
      await expectValidSignature(
        request.url,
        request.init.method,
        request.init.headers.authorization,
        OPERATION_ID,
      );
    }
  });

  it("does not retry a POST after the endpoint reports outcome_unknown", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await expect(executeOAuthReprovision({
      env: validEnv(),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init.method === "GET") return jsonResponse({ operationId: OPERATION_ID, status: "in_progress" });
        return jsonResponse({ operationId: OPERATION_ID, status: "outcome_unknown" }, 503);
      },
      sleep: async () => {},
    })).rejects.toThrow("outcome_unknown");

    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    await expectValidSignature(
      requests[1].url,
      requests[1].init.method,
      requests[1].init.headers.authorization,
      OPERATION_ID,
    );
  });

  it("rejects invalid origins, confirmation, and missing or malformed HMAC keys before network access", async () => {
    const fetchImpl = async () => {
      throw new Error("network must not be reached");
    };
    const invalid = [
      { MCP_UPDATE_CONTROL_PUBLIC_URL: "http://mcp-v3-update-control.example.workers.dev/" },
      { MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-v3-update-control.example.workers.dev/path" },
      { UPDATE_CONTROL_OAUTH_CONFIRM: "NO" },
      { UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY: undefined },
      { UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY: "short" },
      { UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY: "A".repeat(64) },
    ];
    for (const override of invalid) {
      await expect(preflightOAuthReprovision({
        env: validEnv(override),
        fetchImpl,
      })).rejects.toThrow();
    }
  });

  it("bounds operation responses before parsing", async () => {
    const oversized = new Response("x".repeat(16 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(diagnoseOAuthReprovisionStatus({
      env: validEnv(),
      fetchImpl: async () => oversized,
    })).rejects.toThrow("size limit");
  });
});
