import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@vs-code-gpt/shared";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type BrowserConfirmationCategory =
  | "submit-form"
  | "publish-content"
  | "send-message"
  | "delete-or-cancel"
  | "purchase-or-payment"
  | "change-credentials"
  | "accept-terms-or-contract"
  | "upload-file";

export interface BrowserConfirmationBinding {
  tabId: string;
  origin: string;
  url: string;
  category: BrowserConfirmationCategory;
  action: string;
  target: string;
}

interface PendingConfirmation {
  binding: BrowserConfirmationBinding;
  expiresAtMs: number;
}

export class BrowserConfirmationRegistry {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  create(binding: BrowserConfirmationBinding): { confirmationId: string; expiresAt: string } {
    this.pruneExpired();
    const confirmationId = randomBytes(18).toString("base64url");
    const expiresAtMs = Date.now() + this.ttlMs;
    this.pending.set(confirmationId, { binding: { ...binding }, expiresAtMs });
    return { confirmationId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  clear(): void {
    this.pending.clear();
  }

  hasPendingTabs(tabIds: readonly string[]): boolean {
    this.pruneExpired();
    const ids = new Set(tabIds);
    return [...this.pending.values()].some((pending) =>
      ids.has(pending.binding.tabId),
    );
  }

  discardTabs(tabIds: readonly string[]): void {
    const ids = new Set(tabIds);
    for (const [confirmationId, pending] of this.pending) {
      if (ids.has(pending.binding.tabId)) this.pending.delete(confirmationId);
    }
  }

  consume(confirmationId: string, binding: BrowserConfirmationBinding): void {
    this.pruneExpired();
    const pending = this.pending.get(confirmationId);
    if (!pending || pending.expiresAtMs <= Date.now()) {
      this.pending.delete(confirmationId);
      throw new AppError(
        "BROWSER_CONFIRMATION_INVALID",
        "Browser confirmation is missing or expired.",
      );
    }
    if (!sameBinding(pending.binding, binding)) {
      throw new AppError(
        "BROWSER_CONFIRMATION_INVALID",
        "Browser confirmation does not match this action.",
      );
    }
    this.pending.delete(confirmationId);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAtMs <= now) this.pending.delete(id);
    }
  }
}

function sameBinding(left: BrowserConfirmationBinding, right: BrowserConfirmationBinding): boolean {
  return (
    safeEqual(left.tabId, right.tabId) &&
    safeEqual(left.origin, right.origin) &&
    safeEqual(left.url, right.url) &&
    left.category === right.category &&
    safeEqual(left.action, right.action) &&
    safeEqual(left.target, right.target)
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
