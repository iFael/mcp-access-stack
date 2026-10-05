import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { resolveOrchestratorReadApiToken } from "../../src/server.js";

describe("Oracle read API credential-file loading", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("loads a protected token file without putting the token in process arguments", () => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-orchestrator-credential-"));
    const credentials = path.join(root, "credentials");
    mkdirSync(credentials, { mode: 0o700 });
    const tokenFile = path.join(credentials, "orchestrator-token");
    writeFileSync(tokenFile, `${"t".repeat(48)}\n`, { mode: 0o600 });
    expect(resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: tokenFile,
    })).toBe("t".repeat(48));
  });

  it("accepts systemd LoadCredential mode 0440 only inside CREDENTIALS_DIRECTORY", () => {
    if (process.platform === "win32") return;

    root = mkdtempSync(path.join(tmpdir(), "mcp-orchestrator-systemd-credential-"));
    const credentials = path.join(root, "credentials");
    mkdirSync(credentials, { mode: 0o700 });

    const systemdToken = path.join(credentials, "orchestrator-token");
    writeFileSync(systemdToken, `${"s".repeat(48)}\n`, { mode: 0o600 });
    chmodSync(systemdToken, 0o440);
    expect(resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: systemdToken,
      CREDENTIALS_DIRECTORY: credentials,
    })).toBe("s".repeat(48));

    const outsideToken = path.join(root, "outside-token");
    writeFileSync(outsideToken, "o".repeat(48), { mode: 0o600 });
    chmodSync(outsideToken, 0o440);
    expect(() => resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: outsideToken,
      CREDENTIALS_DIRECTORY: credentials,
    })).toThrow(/permissions/u);
  });

  it("retains direct environment compatibility for non-systemd development", () => {
    expect(resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN: "e".repeat(48),
    })).toBe("e".repeat(48));
  });

  it("fails closed when both sources are configured", () => {
    expect(() => resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN: "e".repeat(48),
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: "/run/credentials/token",
    })).toThrow(/exactly one/u);
  });

  it("rejects a symlink, loose POSIX permissions, and an empty file", () => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-orchestrator-credential-"));
    const tokenFile = path.join(root, "token");
    const link = path.join(root, "token-link");
    writeFileSync(tokenFile, "s".repeat(48), { mode: 0o600 });
    symlinkSync(tokenFile, link);
    expect(() => resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: link,
    })).toThrow(/regular file/u);

    if (process.platform !== "win32") {
      chmodSync(tokenFile, 0o644);
      expect(lstatSync(tokenFile).mode & 0o077).not.toBe(0);
      expect(() => resolveOrchestratorReadApiToken({
        UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: tokenFile,
      })).toThrow(/permissions/u);
    }

    const empty = path.join(root, "empty-token");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(() => resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: empty,
    })).toThrow(/empty/u);
  });

  it("rejects relative credential file paths", () => {
    expect(() => resolveOrchestratorReadApiToken({
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: "credentials/token",
    })).toThrow(/absolute/u);
  });
});
