import { describe, expect, it } from "@jest/globals";
import {
  UPDATE_CONTROL_DEPLOY_SECRET_INPUTS,
  UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS,
  validateUpdateControlDeployEnvironment,
} from "../../../../tooling/update-control-deploy-preflight.mjs";

const VALID_ENV = {
  UPDATE_CONTROL_CF_API_TOKEN: "cloudflare-deploy-token-test-value",
  ORACLE_ACCESS_CLIENT_SECRET: "o".repeat(40),
  UPDATE_CONTROL_ORCHESTRATOR_TOKEN: "b".repeat(48),
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  ORACLE_ACCESS_CLIENT_ID: "oracle-access-client-id",
  MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-update-control.example.test/",
  ORCHESTRATOR_READ_API_URL: "https://oracle-read.example.test/",
  UPDATE_CONTROL_OAUTH_REPROVISION_URL: "https://update-control-ops.example.test/_operations/oauth/reprovision",
  UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
  UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE: "update-control-oauth-operations",
};

describe("Update Control deploy configuration preflight", () => {
  it("accepts the complete typed runtime contract without returning values", () => {
    expect(validateUpdateControlDeployEnvironment(VALID_ENV)).toEqual([]);
  });

  it("fails each missing required secret and variable by name and correct GitHub classification", () => {
    for (const name of UPDATE_CONTROL_DEPLOY_SECRET_INPUTS) {
      const errors = validateUpdateControlDeployEnvironment({ ...VALID_ENV, [name]: "" });
      expect(errors.some((error) => error.includes(`secret ${name} is missing`))).toBe(true);
    }
    for (const name of UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS) {
      const errors = validateUpdateControlDeployEnvironment({ ...VALID_ENV, [name]: "" });
      expect(errors.some((error) => error.includes(`variable ${name} is missing`))).toBe(true);
    }
  });

  it("rejects workers.dev/preview origins, invalid URLs, and OAuth operations sharing the public origin", () => {
    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-update-control.example.workers.dev/",
    }).some((error) => error.includes("MCP_UPDATE_CONTROL_PUBLIC_URL is invalid"))).toBe(true);

    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      ORCHESTRATOR_READ_API_URL: "http://oracle-read.example.test/",
    }).some((error) => error.includes("ORCHESTRATOR_READ_API_URL is invalid"))).toBe(true);

    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_OAUTH_REPROVISION_URL: "https://mcp-update-control.example.test/_operations/oauth/reprovision",
    }).some((error) => error.includes("UPDATE_CONTROL_OAUTH_REPROVISION_URL must use a distinct origin"))).toBe(true);

    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_OAUTH_REPROVISION_URL: "https://ops.example.test/admin/reset",
    }).some((error) => error.includes("UPDATE_CONTROL_OAUTH_REPROVISION_URL is invalid"))).toBe(true);

    expect(validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_OAUTH_REPROVISION_URL: "https://ops.example.workers.dev/_operations/oauth/reprovision",
    }).some((error) => error.includes("UPDATE_CONTROL_OAUTH_REPROVISION_URL is invalid"))).toBe(true);
  });

  it("rejects malformed credentials without including any supplied secret values in diagnostics", () => {
    const sentinel = "NEVER-ECHO-THIS-SECRET-8j6Yp1";
    const errors = validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_CF_API_TOKEN: sentinel,
      ORACLE_ACCESS_CLIENT_SECRET: "short",
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN: "also-short",
      CLOUDFLARE_ACCOUNT_ID: "not-an-account-id",
      UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE: "x".repeat(513),
    });
    const diagnostics = errors.join("\n");
    expect(diagnostics).toContain("ORACLE_ACCESS_CLIENT_SECRET");
    expect(diagnostics).toContain("UPDATE_CONTROL_ORCHESTRATOR_TOKEN");
    expect(diagnostics).not.toContain(sentinel);
    expect(diagnostics).not.toContain("short");
  });

  it("keeps owner and OAuth-operation credentials outside the normal deployment contract", () => {
    const normalNames = [...UPDATE_CONTROL_DEPLOY_SECRET_INPUTS, ...UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS];
    expect(normalNames).not.toContain("MCP_OWNER_TOKEN");
    expect(normalNames).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
    expect(normalNames).not.toContain("UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_ID");
    expect(normalNames).not.toContain("UPDATE_CONTROL_OAUTH_ACCESS_CLIENT_SECRET");
  });
});
