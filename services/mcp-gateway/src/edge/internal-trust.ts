import { createHash, timingSafeEqual } from "node:crypto";
import {
  parseAuthenticatedEdgePrincipal,
  type AuthenticatedEdgePrincipal,
} from "@mcp-access-stack/edge-protocol";
import type { RequestHandler } from "express";
import type { AuthenticatedRequest } from "../http/mcp-middleware.js";

export const EDGE_INTERNAL_ASSERTION_HEADER = "x-mcp-edge-internal-assertion";
export const EDGE_INTERNAL_PRINCIPAL_HEADER = "x-mcp-edge-principal";

const MAX_PRINCIPAL_HEADER_BYTES = 8 * 1024;
const MIN_INTERNAL_ASSERTION_LENGTH = 43;
const MAX_INTERNAL_ASSERTION_LENGTH = 128;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface EdgeTrustConfig {
  internalAssertion: string;
}

export function assertValidEdgeInternalAssertion(value: string): void {
  if (
    value.length < MIN_INTERNAL_ASSERTION_LENGTH ||
    value.length > MAX_INTERNAL_ASSERTION_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error("Edge internal assertion must be a base64url value derived from at least 32 random bytes.");
  }
}

export function encodeEdgeAuthenticatedPrincipal(principal: AuthenticatedEdgePrincipal): string {
  return Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
}

export function decodeEdgeAuthenticatedPrincipal(value: string): AuthenticatedEdgePrincipal | null {
  if (
    value.length === 0 ||
    value.length > MAX_PRINCIPAL_HEADER_BYTES ||
    !BASE64URL_PATTERN.test(value)
  ) return null;
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return parseAuthenticatedEdgePrincipal(parsed);
  } catch {
    return null;
  }
}

export function createEdgeTrustedAuthenticationMiddleware(config: EdgeTrustConfig): RequestHandler {
  assertValidEdgeInternalAssertion(config.internalAssertion);
  const expectedDigest = digest(config.internalAssertion);

  return (request: AuthenticatedRequest, response, next) => {
    const assertion = request.header(EDGE_INTERNAL_ASSERTION_HEADER);
    const encodedPrincipal = request.header(EDGE_INTERNAL_PRINCIPAL_HEADER);
    if (
      !assertion ||
      !encodedPrincipal ||
      !timingSafeEqual(expectedDigest, digest(assertion))
    ) {
      response.status(401).json({ error: "edge_trust_invalid" });
      return;
    }

    const principal = decodeEdgeAuthenticatedPrincipal(encodedPrincipal);
    if (!principal) {
      response.status(401).json({ error: "edge_trust_invalid" });
      return;
    }

    delete request.headers[EDGE_INTERNAL_ASSERTION_HEADER];
    delete request.headers[EDGE_INTERNAL_PRINCIPAL_HEADER];
    request.auth = {
      token: "edge-trusted",
      clientId: "edge-control-plane",
      scopes: [...principal.scopes],
      extra: {
        subject: principal.subject,
        ...(principal.ownerScope === undefined ? {} : { ownerScope: principal.ownerScope }),
      },
    };
    next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
