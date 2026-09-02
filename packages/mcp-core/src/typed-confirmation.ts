import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./browser-idempotency.js";
import {
  confirmableSourceControlOperationNameSchema,
  type ConfirmableSourceControlOperationName,
} from "./source-control-contracts.js";
import { AppError } from "./errors.js";

export const MAX_TYPED_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

export interface TypedConfirmationBinding {
  workspaceId: string;
  operation: ConfirmableSourceControlOperationName;
  targetResource: string;
  canonicalArgumentsDigest: string;
}

export interface TypedConfirmationRegistryOptions {
  ttlMs?: number;
  now?: () => number;
}

interface PendingTypedConfirmation {
  binding: TypedConfirmationBinding;
  expiresAtMs: number;
}

export class TypedConfirmationRegistry {
  private readonly pending = new Map<string, PendingTypedConfirmation>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TypedConfirmationRegistryOptions = {}) {
    const ttlMs = options.ttlMs ?? MAX_TYPED_CONFIRMATION_TTL_MS;
    if (
      !Number.isInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_TYPED_CONFIRMATION_TTL_MS
    ) {
      throw new RangeError(
        `Typed confirmation TTL must be an integer between 1 and ${MAX_TYPED_CONFIRMATION_TTL_MS} ms (10 minutes).`,
      );
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  create(
    binding: TypedConfirmationBinding,
  ): { confirmationId: string; expiresAt: string } {
    const parsed = parseBinding(binding);
    this.pruneExpired();
    const confirmationId = randomBytes(18).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    this.pending.set(confirmationId, { binding: parsed, expiresAtMs });
    return {
      confirmationId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(confirmationId: string, binding: TypedConfirmationBinding): void {
    const parsed = parseBinding(binding);
    this.pruneExpired();
    const pending = this.pending.get(confirmationId);
    if (!pending || pending.expiresAtMs <= this.now()) {
      this.pending.delete(confirmationId);
      throw invalidConfirmation("Source-control confirmation is missing or expired.");
    }
    if (!sameBinding(pending.binding, parsed)) {
      throw invalidConfirmation(
        "Source-control confirmation does not match this typed operation.",
      );
    }
    this.pending.delete(confirmationId);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [confirmationId, pending] of this.pending) {
      if (pending.expiresAtMs <= now) {
        this.pending.delete(confirmationId);
      }
    }
  }
}

export function canonicalSourceControlArgumentsDigest(value: unknown): string {
  const canonicalValue = removeEphemeralAndRejectSensitive(value);
  return createHash("sha256").update(canonicalJson(canonicalValue)).digest("hex");
}

function parseBinding(binding: TypedConfirmationBinding): TypedConfirmationBinding {
  if (binding.workspaceId.trim().length === 0) {
    throw new TypeError("Typed confirmation workspaceId cannot be blank.");
  }
  if (binding.targetResource.trim().length === 0) {
    throw new TypeError("Typed confirmation targetResource cannot be blank.");
  }
  confirmableSourceControlOperationNameSchema.parse(binding.operation);
  if (!/^[a-f0-9]{64}$/u.test(binding.canonicalArgumentsDigest)) {
    throw new TypeError("Typed confirmation canonicalArgumentsDigest must be SHA-256 hex.");
  }
  return { ...binding };
}

function sameBinding(
  left: TypedConfirmationBinding,
  right: TypedConfirmationBinding,
): boolean {
  return (
    safeEqual(left.workspaceId, right.workspaceId) &&
    left.operation === right.operation &&
    safeEqual(left.targetResource, right.targetResource) &&
    safeEqual(left.canonicalArgumentsDigest, right.canonicalArgumentsDigest)
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidConfirmation(message: string): AppError {
  return new AppError("SOURCE_CONTROL_CONFIRMATION_INVALID", message);
}

function removeEphemeralAndRejectSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => removeEphemeralAndRejectSensitive(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Source-control canonical arguments must be JSON objects.");
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeSensitiveKey(key);
    if (normalizedKey === "confirmationid") {
      continue;
    }
    if (isSensitiveFieldKey(normalizedKey)) {
      throw new TypeError(
        `Source-control canonical arguments contain sensitive credential field '${key}'.`,
      );
    }
    result[key] = removeEphemeralAndRejectSensitive(entry);
  }
  return result;
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveFieldKey(key: string): boolean {
  return (
    key.includes("authorization") ||
    key === "token" ||
    key.endsWith("token") ||
    key.includes("credential") ||
    key.includes("password") ||
    key.includes("secret") ||
    key.endsWith("apikey") ||
    key.includes("privatekey")
  );
}
