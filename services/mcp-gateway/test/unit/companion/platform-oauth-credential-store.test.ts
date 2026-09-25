import { describe, expect, it, jest } from "@jest/globals";
import {
  LinuxSecretServiceOAuthCredentialStore,
  MacOSKeychainOAuthCredentialStore,
  type SecretCommandRequest,
  type SecretCommandResult,
} from "../../../src/companion/platform-oauth-credential-store.js";

const credential = {
  clientId: "client-1",
  scope: "workspaces:read",
  refreshToken: "refresh-secret-1",
};

describe("platform OAuth credential stores", () => {
  it("uses Linux Secret Service stdin for secret writes", async () => {
    const calls: SecretCommandRequest[] = [];
    const run = jest.fn(async (request: SecretCommandRequest): Promise<SecretCommandResult> => {
      calls.push(request);
      if (request.args[0] === "lookup") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(credential) + "\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = new LinuxSecretServiceOAuthCredentialStore("oauth-test", run);

    await expect(store.read()).resolves.toEqual(credential);
    await store.write(credential);
    await store.clear();

    expect(calls[1]?.file).toBe("secret-tool");
    expect(calls[1]?.args.join(" ")).not.toContain(credential.refreshToken);
    expect(calls[1]?.stdin).toContain(credential.refreshToken);
    expect(calls[2]?.args[0]).toBe("clear");
  });

  it("treats an empty Linux Secret Service lookup as no stored credential", async () => {
    const store = new LinuxSecretServiceOAuthCredentialStore(
      "oauth-test",
      async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    );
    await expect(store.read()).resolves.toBeNull();
  });

  it("fails closed when Linux Secret Service itself errors", async () => {
    const store = new LinuxSecretServiceOAuthCredentialStore(
      "oauth-test",
      async () => ({ exitCode: 2, stdout: "", stderr: "service unavailable" }),
    );
    await expect(store.read()).rejects.toMatchObject({
      code: "CREDENTIAL_BROKER_UNAVAILABLE",
    });
  });

  it("round-trips macOS Keychain commands and tolerates missing items", async () => {
    const calls: SecretCommandRequest[] = [];
    const run = jest.fn(async (request: SecretCommandRequest): Promise<SecretCommandResult> => {
      calls.push(request);
      if (request.args[0] === "find-generic-password") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(credential) + "\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const store = new MacOSKeychainOAuthCredentialStore("oauth-test", run);

    await expect(store.read()).resolves.toEqual(credential);
    await store.write(credential);
    await store.clear();

    expect(calls[1]?.file).toBe("security");
    expect(calls[1]?.args).toEqual(expect.arrayContaining([
      "add-generic-password",
      "-a",
      "oauth-test",
      "-U",
      "-w",
    ]));
    expect(calls[1]?.args.join(" ")).not.toContain(credential.refreshToken);
    expect(calls[1]?.stdin).toBe(JSON.stringify(credential) + "\n");
    expect(calls[2]?.args[0]).toBe("delete-generic-password");

    const missing = new MacOSKeychainOAuthCredentialStore(
      "oauth-test",
      async () => ({
        exitCode: 44,
        stdout: "",
        stderr: "The specified item could not be found in the keychain.",
      }),
    );
    await expect(missing.read()).resolves.toBeNull();
    await expect(missing.clear()).resolves.toBeUndefined();
  });
});
