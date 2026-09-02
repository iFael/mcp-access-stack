import { z } from "zod";
import { AppError } from "./errors.js";
import {
  sourceControlOperationNameSchema,
  type SourceControlOperationName,
} from "./source-control-contracts.js";

export interface MutationReceiptIdentity {
  workspaceId: string;
  operation: SourceControlOperationName;
  targetResource: string;
  canonicalArgumentsDigest: string;
  idempotencyKey: string;
}

export type MutationReceiptState =
  | "reserved"
  | "executing"
  | "completed"
  | "reconciliation_required";

export type MutationReceiptPublicResult =
  | null
  | boolean
  | number
  | string
  | MutationReceiptPublicResult[]
  | { [key: string]: MutationReceiptPublicResult };

export interface MutationReceipt {
  identity: MutationReceiptIdentity;
  state: MutationReceiptState;
  result?: MutationReceiptPublicResult;
}

export type MutationReceiptReservation =
  | {
      disposition: "execute";
      receipt: MutationReceipt;
    }
  | {
      disposition: "replay_completed";
      receipt: MutationReceipt;
    }
  | {
      disposition: "reconciliation_required";
      receipt: MutationReceipt;
    };

export interface MutationReceiptStore {
  reserve(identity: MutationReceiptIdentity): Promise<MutationReceiptReservation>;
  markExecuting(identity: MutationReceiptIdentity): Promise<MutationReceipt>;
  markReconciliationRequired(
    identity: MutationReceiptIdentity,
  ): Promise<MutationReceipt>;
  markCompleted(
    identity: MutationReceiptIdentity,
    result: unknown,
  ): Promise<MutationReceipt>;
  get(idempotencyKey: string): Promise<MutationReceipt | undefined>;
}

export const mutationReceiptIdentitySchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    operation: sourceControlOperationNameSchema,
    targetResource: z.string().trim().min(1).max(512),
    canonicalArgumentsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    idempotencyKey: z.string().trim().min(1).max(512),
  })
  .strict();

export const mutationReceiptStateSchema = z.enum([
  "reserved",
  "executing",
  "completed",
  "reconciliation_required",
]);

export class InMemoryMutationReceiptStore implements MutationReceiptStore {
  private readonly receipts = new Map<string, MutationReceipt>();

  async reserve(
    identity: MutationReceiptIdentity,
  ): Promise<MutationReceiptReservation> {
    const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
    const existing = this.receipts.get(parsedIdentity.idempotencyKey);
    const reservation = reserveMutationReceipt(existing, parsedIdentity);
    if (reservation.disposition === "execute") {
      this.receipts.set(parsedIdentity.idempotencyKey, cloneReceipt(reservation.receipt));
    }
    return cloneReservation(reservation);
  }

  async markExecuting(identity: MutationReceiptIdentity): Promise<MutationReceipt> {
    const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
    const receipt = markMutationReceiptExecuting(
      this.receipts.get(parsedIdentity.idempotencyKey),
      parsedIdentity,
    );
    this.receipts.set(parsedIdentity.idempotencyKey, cloneReceipt(receipt));
    return cloneReceipt(receipt);
  }

  async markReconciliationRequired(
    identity: MutationReceiptIdentity,
  ): Promise<MutationReceipt> {
    const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
    const receipt = markMutationReceiptReconciliationRequired(
      this.receipts.get(parsedIdentity.idempotencyKey),
      parsedIdentity,
    );
    this.receipts.set(parsedIdentity.idempotencyKey, cloneReceipt(receipt));
    return cloneReceipt(receipt);
  }

  async markCompleted(
    identity: MutationReceiptIdentity,
    result: unknown,
  ): Promise<MutationReceipt> {
    const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
    const receipt = markMutationReceiptCompleted(
      this.receipts.get(parsedIdentity.idempotencyKey),
      parsedIdentity,
      result,
    );
    this.receipts.set(parsedIdentity.idempotencyKey, cloneReceipt(receipt));
    return cloneReceipt(receipt);
  }

  async get(idempotencyKey: string): Promise<MutationReceipt | undefined> {
    const receipt = this.receipts.get(idempotencyKey);
    return receipt === undefined ? undefined : cloneReceipt(receipt);
  }
}

export function reserveMutationReceipt(
  existing: MutationReceipt | undefined,
  identity: MutationReceiptIdentity,
): MutationReceiptReservation {
  const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
  if (!existing) {
    return {
      disposition: "execute",
      receipt: {
        identity: parsedIdentity,
        state: "reserved",
      },
    };
  }

  const parsedExisting = parseMutationReceipt(existing);
  assertSameIdentity(parsedExisting.identity, parsedIdentity);
  if (parsedExisting.state === "completed") {
    return {
      disposition: "replay_completed",
      receipt: cloneReceipt(parsedExisting),
    };
  }
  return {
    disposition: "reconciliation_required",
    receipt: cloneReceipt(parsedExisting),
  };
}

export function markMutationReceiptExecuting(
  existing: MutationReceipt | undefined,
  identity: MutationReceiptIdentity,
): MutationReceipt {
  const receipt = requireExistingReceipt(existing, identity);
  if (receipt.state !== "reserved") {
    throw invalidTransition(receipt.state, "executing");
  }
  return {
    identity: receipt.identity,
    state: "executing",
  };
}

export function markMutationReceiptReconciliationRequired(
  existing: MutationReceipt | undefined,
  identity: MutationReceiptIdentity,
): MutationReceipt {
  const receipt = requireExistingReceipt(existing, identity);
  if (receipt.state === "reconciliation_required") {
    return receipt;
  }
  if (receipt.state !== "executing") {
    throw invalidTransition(receipt.state, "reconciliation_required");
  }
  return {
    identity: receipt.identity,
    state: "reconciliation_required",
  };
}

export function markMutationReceiptCompleted(
  existing: MutationReceipt | undefined,
  identity: MutationReceiptIdentity,
  result: unknown,
): MutationReceipt {
  const receipt = requireExistingReceipt(existing, identity);
  if (
    receipt.state !== "executing" &&
    receipt.state !== "reconciliation_required"
  ) {
    throw invalidTransition(receipt.state, "completed");
  }
  const publicResult = parseMutationReceiptPublicResult(result);
  return {
    identity: receipt.identity,
    state: "completed",
    result: publicResult,
  };
}

export function parseMutationReceipt(value: unknown): MutationReceipt {
  if (!isPlainObject(value)) {
    throw new AppError("INVALID_ARGUMENT", "Mutation receipt must be an object.");
  }
  const record = value as Record<string, unknown>;
  const identity = mutationReceiptIdentitySchema.parse(record.identity);
  const state = mutationReceiptStateSchema.parse(record.state);
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "identity" && key !== "state" && key !== "result")) {
    throw new AppError("INVALID_ARGUMENT", "Mutation receipt contains unknown fields.");
  }
  if (state === "completed") {
    if (!("result" in record)) {
      throw new AppError("INVALID_ARGUMENT", "Completed mutation receipt is missing result.");
    }
    return {
      identity,
      state,
      result: parseMutationReceiptPublicResult(record.result),
    };
  }
  if ("result" in record) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Non-completed mutation receipt cannot contain result.",
    );
  }
  return { identity, state };
}

export function parseMutationReceiptPublicResult(
  value: unknown,
): MutationReceiptPublicResult {
  return parsePublicResultValue(value, []);
}

function requireExistingReceipt(
  existing: MutationReceipt | undefined,
  identity: MutationReceiptIdentity,
): MutationReceipt {
  if (!existing) {
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Mutation receipt does not exist for this idempotency key.",
    );
  }
  const parsedIdentity = mutationReceiptIdentitySchema.parse(identity);
  const parsedExisting = parseMutationReceipt(existing);
  assertSameIdentity(parsedExisting.identity, parsedIdentity);
  return parsedExisting;
}

function assertSameIdentity(
  existing: MutationReceiptIdentity,
  requested: MutationReceiptIdentity,
): void {
  if (
    existing.workspaceId !== requested.workspaceId ||
    existing.operation !== requested.operation ||
    existing.targetResource !== requested.targetResource ||
    existing.canonicalArgumentsDigest !== requested.canonicalArgumentsDigest ||
    existing.idempotencyKey !== requested.idempotencyKey
  ) {
    throw new AppError(
      "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT",
      "The idempotency key is already associated with a different source-control mutation identity.",
    );
  }
}

function invalidTransition(
  from: MutationReceiptState,
  to: MutationReceiptState,
): AppError {
  return new AppError(
    "EXECUTION_STATE_INVALID",
    `Mutation receipt cannot transition from ${from} to ${to}.`,
  );
}

function parsePublicResultValue(
  value: unknown,
  path: string[],
): MutationReceiptPublicResult {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidPublicResult(path, "non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parsePublicResultValue(entry, [...path, String(index)]),
    );
  }
  if (!isPlainObject(value)) {
    throw invalidPublicResult(path, `unsupported ${typeof value}`);
  }

  const result: Record<string, MutationReceiptPublicResult> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveReceiptField(key)) {
      throw invalidPublicResult([...path, key], "sensitive field");
    }
    result[key] = parsePublicResultValue(entry, [...path, key]);
  }
  return result;
}

function isSensitiveReceiptField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    normalized === "confirmationid" ||
    normalized.includes("authorization") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.endsWith("apikey") ||
    normalized.includes("privatekey")
  );
}

function invalidPublicResult(path: string[], reason: string): AppError {
  const location = path.length === 0 ? "result" : `result.${path.join(".")}`;
  return new AppError(
    "INVALID_ARGUMENT",
    `Mutation receipt ${location} contains an invalid ${reason}.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneReceipt(receipt: MutationReceipt): MutationReceipt {
  return JSON.parse(JSON.stringify(receipt)) as MutationReceipt;
}

function cloneReservation(
  reservation: MutationReceiptReservation,
): MutationReceiptReservation {
  return {
    disposition: reservation.disposition,
    receipt: cloneReceipt(reservation.receipt),
  } as MutationReceiptReservation;
}
