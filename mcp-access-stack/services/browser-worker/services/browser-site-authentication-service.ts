import { AppError } from "@vs-code-gpt/shared";
import type { AuthorizedSitePolicy } from "../domain/authorized-site-policy.js";
import type {
  BrowserCredentialAuthenticationResult,
  BrowserDriver,
} from "../drivers/browser-driver.js";
import type {
  BrowserCredentialBroker,
  CredentialBrokerReadResult,
} from "./windows-credential-broker-client.js";

export type BrowserSiteAuthenticationOutcome =
  | { status: "not-required" }
  | { status: "session-reused" }
  | { status: "performed" }
  | { status: "interaction-required"; reason: "mfa-or-captcha" }
  | {
      status: "failed";
      reason:
        | "credential-unavailable"
        | "broker-unavailable"
        | "broker-access-denied"
        | "broker-protocol-mismatch"
        | "credentials-invalid"
        | "login-form-not-found"
        | "submit-outcome-unknown"
        | "postcondition-not-reached"
        | "capability-unavailable";
    };

export interface BrowserSiteAuthenticationServiceOptions {
  loginTimeoutMs: number;
  invalidCredentialBackoffMs: number;
}

export class BrowserSiteAuthenticationService {
  private readonly invalidUntil = new Map<string, number>();

  constructor(
    private readonly driver: BrowserDriver,
    private readonly broker: BrowserCredentialBroker,
    private readonly options: BrowserSiteAuthenticationServiceOptions,
  ) {}

  async authenticate(
    policy: AuthorizedSitePolicy,
    signal?: AbortSignal,
  ): Promise<BrowserSiteAuthenticationOutcome> {
    if (policy.loginStrategy === "none") return { status: "not-required" };
    if (
      !this.driver.inspectAuthenticationState ||
      !this.driver.authenticateWithCredential
    ) {
      return { status: "failed", reason: "capability-unavailable" };
    }

    const inspection = await this.driver.inspectAuthenticationState();
    if (inspection.state === "authenticated") return { status: "session-reused" };
    if (inspection.state === "interaction-required") {
      return { status: "interaction-required", reason: inspection.reason };
    }
    if (inspection.state !== "login-required") {
      return { status: "failed", reason: "login-form-not-found" };
    }

    const accountId = policy.credentialAccountId ?? "default";
    const backoffKey = `${policy.siteId}\u0000${accountId}`;
    const blockedUntil = this.invalidUntil.get(backoffKey) ?? 0;
    if (blockedUntil > Date.now()) {
      return { status: "failed", reason: "credentials-invalid" };
    }
    this.invalidUntil.delete(backoffKey);

    let brokerResult: CredentialBrokerReadResult;
    try {
      brokerResult = await this.broker.read({
        siteId: policy.siteId,
        accountId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "OPERATION_CANCELLED") {
        throw error;
      }
      if (
        error instanceof AppError &&
        error.code === "CREDENTIAL_BROKER_PROTOCOL_MISMATCH"
      ) {
        return { status: "failed", reason: "broker-protocol-mismatch" };
      }
      if (
        error instanceof AppError &&
        error.code === "CREDENTIAL_BROKER_ACCESS_DENIED"
      ) {
        return { status: "failed", reason: "broker-access-denied" };
      }
      return { status: "failed", reason: "broker-unavailable" };
    }
    if (brokerResult.status !== "success") {
      return mapBrokerFailure(brokerResult);
    }

    try {
      const result = await this.driver.authenticateWithCredential(
        brokerResult.secret,
        {
          timeoutMs: this.options.loginTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (result.status === "failed" && result.reason === "credentials-invalid") {
        this.invalidUntil.set(
          backoffKey,
          Date.now() + this.options.invalidCredentialBackoffMs,
        );
      }
      return mapDriverResult(result);
    } finally {
      brokerResult.secret.dispose();
    }
  }

  clearTaskState(): void {
    for (const [key, expiresAt] of this.invalidUntil) {
      if (expiresAt <= Date.now()) this.invalidUntil.delete(key);
    }
  }
}

function mapBrokerFailure(
  result: Exclude<CredentialBrokerReadResult, { status: "success" }>,
): BrowserSiteAuthenticationOutcome {
  if (result.status === "unavailable") {
    return { status: "failed", reason: "credential-unavailable" };
  }
  if (result.status === "access-denied") {
    return { status: "failed", reason: "broker-access-denied" };
  }
  if (result.status === "protocol-mismatch") {
    return { status: "failed", reason: "broker-protocol-mismatch" };
  }
  return { status: "failed", reason: "broker-unavailable" };
}

function mapDriverResult(
  result: BrowserCredentialAuthenticationResult,
): BrowserSiteAuthenticationOutcome {
  if (result.status === "performed") return { status: "performed" };
  if (result.status === "session-reused") return { status: "session-reused" };
  if (result.status === "interaction-required") {
    return { status: "interaction-required", reason: result.reason };
  }
  return { status: "failed", reason: result.reason };
}
