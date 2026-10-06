import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  diagnoseOAuthReprovisionStatus,
  executeOAuthReprovision,
  OAUTH_REPROVISION_CONFIRMATION,
  preflightOAuthReprovision,
} from "../../../../tooling/update-control-oauth-reprovision.mjs";
import {
  activateAdminBootstrap,
  ADMIN_BOOTSTRAP_CONFIRMATION,
  diagnoseAdminBootstrap,
} from "../../../../tooling/update-control-admin-bootstrap.mjs";

const OPERATION_ID = "b795a30e-90d3-4a51-95ed-3c06bbc1e2ad";
const PUBLIC_URL = "https://mcp-v3-update-control.example.workers.dev";
const HMAC_KEY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");

function workflow(path: string) {
  return parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reproEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    UPDATE_CONTROL_OAUTH_CONFIRM: OAUTH_REPROVISION_CONFIRMATION,
    UPDATE_CONTROL_OAUTH_OPERATION_ID: OPERATION_ID,
    UPDATE_CONTROL_ADMIN_HMAC_KEY: HMAC_KEY,
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    ...overrides,
  };
}

function bootstrapEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    UPDATE_CONTROL_ADMIN_BOOTSTRAP_CONFIRM: ADMIN_BOOTSTRAP_CONFIRMATION,
    UPDATE_CONTROL_ADMIN_BOOTSTRAP_OPERATION_ID: OPERATION_ID,
    UPDATE_CONTROL_ADMIN_HMAC_KEY: HMAC_KEY,
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    ...overrides,
  };
}

describe("Update Control operational workflows", () => {
  it("reprovisions OAuth with one administrative HMAC and no human owner credential", () => {
    const definition = workflow("../../../../.github/workflows/update-control-oauth-reprovision.yml");
    expect(definition.on.workflow_dispatch.inputs.confirm_reprovision.options).toEqual([
      "NO",
      "DIAGNOSE_STATUS",
      OAUTH_REPROVISION_CONFIRMATION,
    ]);
    expect(definition.concurrency).toEqual({
      group: "update-control-production",
      "cancel-in-progress": false,
    });
    const serialized = JSON.stringify(definition);
    expect(serialized).toContain("UPDATE_CONTROL_ADMIN_HMAC_KEY");
    expect(serialized).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
    expect(serialized).not.toContain("MCP_OWNER_TOKEN");
    expect(serialized).not.toContain("UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY");
    expect(serialized).not.toContain("wrangler secret put");
    expect(definition.jobs.reprovision.environment.name).toBe("update-control-production");
  });

  it("normal deploy provisions local TOTP encryption and the administrative HMAC without external identity credentials", () => {
    const definition = workflow("../../../../.github/workflows/update-control-deploy.yml");
    const deploy = definition.jobs.deploy;
    const serialized = JSON.stringify(deploy);
    expect(serialized).toContain("UPDATE_CONTROL_ADMIN_HMAC_KEY");
    expect(serialized).toContain("UPDATE_CONTROL_TOTP_ENCRYPTION_KEY");
    expect(serialized).toContain("UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL");
    expect(serialized).toContain("wrangler secret put UPDATE_CONTROL_ADMIN_HMAC_KEY");
    expect(serialized).toContain("wrangler secret put UPDATE_CONTROL_TOTP_ENCRYPTION_KEY");
    expect(serialized).not.toContain("MICROSOFT_CLIENT_SECRET");
    expect(serialized).not.toContain("MICROSOFT_CLIENT_ID");
    expect(serialized).not.toContain("MICROSOFT_TENANT");
    expect(serialized).not.toContain("MCP_OWNER_TOKEN");
    expect(serialized).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
    expect(serialized).not.toContain("UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY");
  });

  it("diagnoses and applies reprovision using the same operation id without replacement credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    expect(await diagnoseOAuthReprovisionStatus({
      env: reproEnv({ UPDATE_CONTROL_OAUTH_CONFIRM: undefined }),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return response({ operationId: OPERATION_ID, status: "not_executed" });
      },
    })).toEqual({
      operationId: OPERATION_ID,
      httpStatus: 200,
      status: "not_executed",
      error: null,
    });

    expect(await preflightOAuthReprovision({
      env: reproEnv(),
      fetchImpl: async () => response({ operationId: OPERATION_ID, status: "not_executed" }),
    })).toEqual({ operationId: OPERATION_ID, status: "not_executed" });

    const sequence = [
      response({ operationId: OPERATION_ID, status: "not_executed" }),
      response({ operationId: OPERATION_ID, status: "in_progress" }, 202),
      response({ operationId: OPERATION_ID, status: "completed" }),
    ];
    expect(await executeOAuthReprovision({
      env: reproEnv(),
      fetchImpl: async () => sequence.shift()!,
      sleep: async () => {},
    })).toEqual({ operationId: OPERATION_ID, status: "completed" });

    expect(requests[0]?.init.headers).toMatchObject({
      authorization: expect.stringMatching(/^HMAC-SHA256 v1=/u),
    });
  });

  it("stops reprovision on outcome_unknown instead of blindly retrying", async () => {
    const requests: RequestInit[] = [];
    await expect(executeOAuthReprovision({
      env: reproEnv(),
      fetchImpl: async (_url, init) => {
        requests.push(init);
        if (init.method === "GET") return response({ operationId: OPERATION_ID, status: "in_progress" });
        return response({ operationId: OPERATION_ID, status: "outcome_unknown" }, 503);
      },
      sleep: async () => {},
    })).rejects.toThrow("outcome_unknown");
    expect(requests.map((item) => item.method)).toEqual(["GET", "POST"]);
  });

  it("uses a distinct explicitly-confirmed bootstrap operation and opens only a short enrollment window", async () => {
    const definition = workflow("../../../../.github/workflows/update-control-admin-bootstrap.yml");
    expect(definition.on.workflow_dispatch.inputs.confirm_bootstrap.options).toEqual([
      "NO",
      "DIAGNOSE_STATUS",
      ADMIN_BOOTSTRAP_CONFIRMATION,
    ]);
    expect(definition.concurrency.group).toBe("update-control-production");
    const serialized = JSON.stringify(definition);
    expect(serialized).toContain("UPDATE_CONTROL_ADMIN_HMAC_KEY");
    expect(serialized).not.toContain("MCP_OWNER_TOKEN");

    expect(await diagnoseAdminBootstrap({
      env: bootstrapEnv({ UPDATE_CONTROL_ADMIN_BOOTSTRAP_CONFIRM: undefined }),
      fetchImpl: async () => response({ operationId: OPERATION_ID, status: "not_executed" }),
    })).toEqual({
      operationId: OPERATION_ID,
      httpStatus: 200,
      status: "not_executed",
      error: null,
    });

    const methods: string[] = [];
    expect(await activateAdminBootstrap({
      env: bootstrapEnv(),
      fetchImpl: async (_url, init) => {
        methods.push(String(init.method));
        return methods.length === 1
          ? response({ operationId: OPERATION_ID, status: "not_executed" })
          : response({ operationId: OPERATION_ID, status: "ready" });
      },
    })).toEqual({ operationId: OPERATION_ID, status: "ready" });
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("rejects malformed admin HMAC configuration before network access", async () => {
    const fetchImpl = async () => {
      throw new Error("network must not be reached");
    };
    for (const override of [
      { UPDATE_CONTROL_ADMIN_HMAC_KEY: undefined },
      { UPDATE_CONTROL_ADMIN_HMAC_KEY: "short" },
      { UPDATE_CONTROL_ADMIN_HMAC_KEY: "A".repeat(64) },
    ]) {
      await expect(preflightOAuthReprovision({
        env: reproEnv(override),
        fetchImpl,
      })).rejects.toThrow();
      await expect(activateAdminBootstrap({
        env: bootstrapEnv(override),
        fetchImpl,
      })).rejects.toThrow();
    }
  });
});
