import { describe, expect, it } from "@jest/globals";
import {
  UPDATE_CONTROL_DEPLOY_SECRET_INPUTS,
  UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS,
  validateUpdateControlDeployEnvironment,
} from "../../../../tooling/update-control-deploy-preflight.mjs";

const VALID_ENV = {
  UPDATE_CONTROL_CF_API_TOKEN: "cloudflare-deploy-token-test-value",
  UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: "c".repeat(48),
  UPDATE_CONTROL_ADMIN_HMAC_KEY: "a".repeat(64),
  MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-test-value",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-v3-update-control.mcp-v3-update-control.workers.dev/",
  MICROSOFT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
  MICROSOFT_TENANT: "organizations",
  UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
};

describe("Update Control deploy configuration preflight", () => {
  it("requires infrastructure, Microsoft Identity and the single administrative HMAC", () => {
    expect(UPDATE_CONTROL_DEPLOY_SECRET_INPUTS).toEqual([
      "UPDATE_CONTROL_CF_API_TOKEN",
      "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN",
      "UPDATE_CONTROL_ADMIN_HMAC_KEY",
      "MICROSOFT_CLIENT_SECRET",
    ]);
    expect(UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "MCP_UPDATE_CONTROL_PUBLIC_URL",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_TENANT",
      "UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL",
    ]);
    expect(validateUpdateControlDeployEnvironment(VALID_ENV)).toEqual([]);
  });

  it("fails every missing setting by name without exposing values", () => {
    for (const name of UPDATE_CONTROL_DEPLOY_SECRET_INPUTS) {
      const errors = validateUpdateControlDeployEnvironment({ ...VALID_ENV, [name]: "" });
      expect(errors.some((error) => error.includes(`secret ${name} is missing`))).toBe(true);
    }
    for (const name of UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS) {
      const errors = validateUpdateControlDeployEnvironment({ ...VALID_ENV, [name]: "" });
      expect(errors.some((error) => error.includes(`variable ${name} is missing`))).toBe(true);
    }
  });

  it("validates Microsoft client id and tenant without treating identity as an owner password", () => {
    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      MICROSOFT_CLIENT_ID: "not-a-guid",
    })).toContain("Required GitHub Environment variable MICROSOFT_CLIENT_ID is invalid.");
    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      MICROSOFT_TENANT: "arbitrary-tenant-name",
    })).toContain("Required GitHub Environment variable MICROSOFT_TENANT is invalid.");
    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "not-an-email",
    })).toContain("Required GitHub Environment variable UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL is invalid.");

    for (const tenant of [
      "common",
      "organizations",
      "consumers",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]) {
      expect(validateUpdateControlDeployEnvironment({ ...VALID_ENV, MICROSOFT_TENANT: tenant })).toEqual([]);
    }
  });

  it("accepts only the canonical workers.dev root origin", () => {
    for (const value of [
      "http://mcp-v3-update-control.example.workers.dev/",
      "https://mcp-v3-update-control.example.test/",
      "https://other-worker.mcp-v3-update-control.workers.dev/",
      "https://mcp-v3-update-control.example.workers.dev/mcp",
      "https://mcp-v3-update-control.example.workers.dev/?unexpected=1",
      "https://user@mcp-v3-update-control.example.workers.dev/",
    ]) {
      expect(validateUpdateControlDeployEnvironment({
        ...VALID_ENV,
        MCP_UPDATE_CONTROL_PUBLIC_URL: value,
      }).some((error) => error.includes("MCP_UPDATE_CONTROL_PUBLIC_URL is invalid"))).toBe(true);
    }
  });

  it("rejects malformed secrets and never includes their values in diagnostics", () => {
    const sentinel = "NEVER-ECHO-THIS-SECRET-8j6Yp1";
    const errors = validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: "short",
      UPDATE_CONTROL_ADMIN_HMAC_KEY: sentinel,
      MICROSOFT_CLIENT_SECRET: "short",
    });
    const diagnostics = errors.join("\n");
    expect(diagnostics).toContain("UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN");
    expect(diagnostics).toContain("UPDATE_CONTROL_ADMIN_HMAC_KEY");
    expect(diagnostics).toContain("MICROSOFT_CLIENT_SECRET");
    expect(diagnostics).not.toContain(sentinel);
    expect(diagnostics).not.toContain("short");
  });

  it("removes legacy human-owner credentials from the deploy contract", () => {
    const names = [...UPDATE_CONTROL_DEPLOY_SECRET_INPUTS, ...UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS];
    expect(names).not.toContain("MCP_OWNER_TOKEN");
    expect(names).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
    expect(names).not.toContain("UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY");
  });
});
