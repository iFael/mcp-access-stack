import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, type ShellName } from "@vs-code-gpt/shared";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface CommandConfirmationBinding {
  workspaceId: string;
  shell: ShellName;
  cwd: string;
  command: string;
}

interface PendingConfirmation {
  binding: CommandConfirmationBinding;
  expiresAtMs: number;
}

export class CommandConfirmationRegistry {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  create(binding: CommandConfirmationBinding): { confirmationId: string; expiresAt: string } {
    this.pruneExpired();
    const confirmationId = randomBytes(18).toString("base64url");
    const expiresAtMs = Date.now() + this.ttlMs;
    this.pending.set(confirmationId, { binding, expiresAtMs });
    return {
      confirmationId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(confirmationId: string, binding: CommandConfirmationBinding): void {
    this.pruneExpired();
    const pending = this.pending.get(confirmationId);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      this.pending.delete(confirmationId);
      throw new AppError(
        "COMMAND_CONFIRMATION_INVALID",
        "Command confirmation is missing or expired.",
      );
    }
    if (!sameBinding(pending.binding, binding)) {
      throw new AppError(
        "COMMAND_CONFIRMATION_INVALID",
        "Command confirmation does not match this command.",
      );
    }
    this.pending.delete(confirmationId);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAtMs <= now) {
        this.pending.delete(id);
      }
    }
  }
}

function sameBinding(
  left: CommandConfirmationBinding,
  right: CommandConfirmationBinding,
): boolean {
  return (
    safeEqual(left.workspaceId, right.workspaceId) &&
    left.shell === right.shell &&
    safeEqual(left.cwd, right.cwd) &&
    safeEqual(left.command, right.command)
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
