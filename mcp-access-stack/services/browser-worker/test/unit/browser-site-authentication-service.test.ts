import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { AuthorizedSitePolicy } from "../../domain/authorized-site-policy.js";
import type { BrowserDriver } from "../../drivers/browser-driver.js";
import { BrowserSiteAuthenticationService } from "../../services/browser-site-authentication-service.js";
import {
  CredentialSecret,
  type BrowserCredentialBroker,
} from "../../services/windows-credential-broker-client.js";

const policy: AuthorizedSitePolicy = {
  siteId: "private-site",
  entryUrl: "https://dev.example.test/LegacySite.asp",
  allowedOrigins: ["https://dev.example.test"],
  deniedOrigins: ["https://example.test"],
  accessMode: "business-read-only",
  loginStrategy: "credential-broker",
  credentialAccountId: "default",
};

describe("BrowserSiteAuthenticationService", () => {
  it("reuses an authenticated session without querying credentials", async () => {
    const broker = brokerMock();
    const driver = driverMock({ inspection: { state: "authenticated" } });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "session-reused",
    });
    expect(broker.read).not.toHaveBeenCalled();
  });

  it("does not query credentials when MFA or CAPTCHA is present", async () => {
    const broker = brokerMock();
    const driver = driverMock({
      inspection: { state: "interaction-required", reason: "mfa-or-captcha" },
    });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "interaction-required",
      reason: "mfa-or-captcha",
    });
    expect(broker.read).not.toHaveBeenCalled();
  });

  it("performs one credential submission and zeroes the secret afterwards", async () => {
    const secret = new CredentialSecret(
      Buffer.from("reader", "utf8"),
      Buffer.from("secret-value", "utf8"),
    );
    const broker = brokerMock({ status: "success", secret });
    const authenticateWithCredential = jest.fn(async () => ({
      status: "performed" as const,
    }));
    const driver = driverMock({
      inspection: { state: "login-required" },
      authenticateWithCredential,
    });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "performed",
    });
    expect(broker.read).toHaveBeenCalledTimes(1);
    expect(authenticateWithCredential).toHaveBeenCalledTimes(1);
    expect([...secret.username]).toEqual(new Array(6).fill(0));
    expect([...secret.password]).toEqual(new Array(12).fill(0));
  });

  it("backs off after invalid credentials and does not read the broker again", async () => {
    const broker = brokerMock({
      status: "success",
      secret: new CredentialSecret(
        Buffer.from("reader", "utf8"),
        Buffer.from("invalid", "utf8"),
      ),
    });
    const driver = driverMock({
      inspection: { state: "login-required" },
      authenticateWithCredential: jest.fn(async () => ({
        status: "failed" as const,
        reason: "credentials-invalid" as const,
      })),
    });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "failed",
      reason: "credentials-invalid",
    });
    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "failed",
      reason: "credentials-invalid",
    });
    expect(broker.read).toHaveBeenCalledTimes(1);
  });

  it("maps broker protocol exceptions without leaking process details", async () => {
    const broker: BrowserCredentialBroker = {
      read: async () => {
        throw new AppError(
          "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
          "internal protocol detail",
        );
      },
    };
    const driver = driverMock({ inspection: { state: "login-required" } });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "failed",
      reason: "broker-protocol-mismatch",
    });
  });

  it("maps broker failures without exposing credential metadata", async () => {
    const broker = brokerMock({ status: "access-denied" });
    const driver = driverMock({ inspection: { state: "login-required" } });
    const service = createService(driver, broker);

    await expect(service.authenticate(policy)).resolves.toEqual({
      status: "failed",
      reason: "broker-access-denied",
    });
  });
});

function createService(
  driver: BrowserDriver,
  broker: BrowserCredentialBroker,
): BrowserSiteAuthenticationService {
  return new BrowserSiteAuthenticationService(driver, broker, {
    loginTimeoutMs: 5_000,
    invalidCredentialBackoffMs: 60_000,
  });
}

function brokerMock(
  result: Awaited<ReturnType<BrowserCredentialBroker["read"]>> = {
    status: "broker-unavailable",
  },
): BrowserCredentialBroker & { read: ReturnType<typeof jest.fn> } {
  return {
    read: jest.fn(async () => result),
  } as BrowserCredentialBroker & { read: ReturnType<typeof jest.fn> };
}

function driverMock(input: {
  inspection: Awaited<ReturnType<NonNullable<BrowserDriver["inspectAuthenticationState"]>>>;
  authenticateWithCredential?: NonNullable<BrowserDriver["authenticateWithCredential"]>;
}): BrowserDriver {
  return {
    kind: "direct",
    isConnected: () => true,
    inspectAuthenticationState: async () => input.inspection,
    authenticateWithCredential:
      input.authenticateWithCredential ??
      (async () => ({ status: "failed", reason: "login-form-not-found" })),
  } as unknown as BrowserDriver;
}
