import { describe, expect, it } from "@jest/globals";
import {
  UPDATE_CONTROL_DEPLOY_SECRET_INPUTS,
  UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS,
  validateUpdateControlDeployEnvironment,
} from "../../../../tooling/update-control-deploy-preflight.mjs";

const VALID_ENV = {
  UPDATE_CONTROL_CF_API_TOKEN: "cloudflare-deploy-token-test-value",
  UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: "c".repeat(48),
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-v3-update-control.mcp-v3-update-control.workers.dev/",
};

describe("Update Control deploy configuration preflight", () => {
  it("requires only the deploy token, channel token, account, and complete canonical Worker workers.dev origin", () => {
    expect(UPDATE_CONTROL_DEPLOY_SECRET_INPUTS).toEqual([
      "UPDATE_CONTROL_CF_API_TOKEN",
      "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN",
    ]);
    expect(UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "MCP_UPDATE_CONTROL_PUBLIC_URL",
    ]);
    expect(validateUpdateControlDeployEnvironment(VALID_ENV)).toEqual([]);
  });

  it("rejects the account subdomain when the Worker name label is missing", () => {
    const errors = validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      MCP_UPDATE_CONTROL_PUBLIC_URL: "https://mcp-v3-update-control.workers.dev",
    });
    expect(errors).toEqual([
      "Required GitHub Environment variable MCP_UPDATE_CONTROL_PUBLIC_URL is invalid.",
    ]);
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

  it("accepts production workers.dev and rejects non-HTTPS, custom, or malformed origins", () => {
    for (const value of [
      "http://mcp-v3-update-control.example.workers.dev/",
      "https://mcp-v3-update-control.example.test/",
      "https://other-worker.mcp-v3-update-control.workers.dev/",
      "https://mcp-v3-update-control.example.workers.dev/mcp",
      "https://mcp-v3-update-control.example.workers.dev/?unexpected=1",
      "https://mcp-v3-update-control.example.workers.dev/#unexpected",
      "https://mcp-v3-update-control.example.workers.dev/../",
      "https://user@mcp-v3-update-control.example.workers.dev/",
      "https://mcp-v3-update-control.example.workers.dev:8443/",
      "not a URL",
    ]) {
      const errors = validateUpdateControlDeployEnvironment({
        ...VALID_ENV,
        MCP_UPDATE_CONTROL_PUBLIC_URL: value,
      });
      expect(errors.some((error) => error.includes("MCP_UPDATE_CONTROL_PUBLIC_URL is invalid"))).toBe(true);
    }
  });

  it("rejects malformed secrets without including supplied values in diagnostics", () => {
    const sentinel = "NEVER-ECHO-THIS-SECRET-8j6Yp1";
    const errors = validateUpdateControlDeployEnvironment({
      ...VALID_ENV,
      UPDATE_CONTROL_CF_API_TOKEN: sentinel,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: "short",
      CLOUDFLARE_ACCOUNT_ID: "not-an-account-id",
    });
    const diagnostics = errors.join("\n");
    expect(diagnostics).toContain("UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN");
    expect(diagnostics).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(diagnostics).not.toContain(sentinel);
    expect(diagnostics).not.toContain("short");
  });

  it("keeps OAuth owner and replacement credentials outside the normal deploy contract", () => {
    const normalNames = [...UPDATE_CONTROL_DEPLOY_SECRET_INPUTS, ...UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS];
    expect(normalNames).not.toContain("MCP_OWNER_TOKEN");
    expect(normalNames).not.toContain("UPDATE_CONTROL_OWNER_TOKEN_NEXT");
  });
});
