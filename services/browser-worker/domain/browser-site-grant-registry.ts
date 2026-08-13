import { randomUUID } from "node:crypto";
import { AppError } from "@vs-code-gpt/shared";
import type { BrowserTask } from "./browser-task-registry.js";
import type { AuthorizedSitePolicy } from "./authorized-site-policy.js";

interface PendingSiteConfirmation {
  confirmationId: string;
  taskId: string;
  ownerScopeHash: string;
  siteId: string;
  purpose: string;
  expiresAt: string;
}

export interface BrowserSiteGrant {
  taskId: string;
  ownerScopeHash: string;
  siteId: string;
  allowedOrigins: string[];
  expiresAt: string;
}

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;

export class BrowserSiteGrantRegistry {
  private readonly pending = new Map<string, PendingSiteConfirmation>();
  private readonly grants = new Map<string, BrowserSiteGrant>();

  createConfirmation(
    task: BrowserTask,
    policy: AuthorizedSitePolicy,
    purpose: string,
  ): PendingSiteConfirmation {
    this.pruneExpired();
    const confirmation: PendingSiteConfirmation = {
      confirmationId: `site-confirm-${randomUUID()}`,
      taskId: task.taskId,
      ownerScopeHash: task.ownerScopeHash,
      siteId: policy.siteId,
      purpose,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    };
    this.pending.set(confirmation.confirmationId, confirmation);
    return { ...confirmation };
  }

  confirm(
    confirmationId: string,
    task: BrowserTask,
    policy: AuthorizedSitePolicy,
    purpose: string,
  ): BrowserSiteGrant {
    this.pruneExpired();
    const pending = this.pending.get(confirmationId);
    if (!pending) {
      throw new AppError(
        "SITE_ACCESS_AUTHORIZATION_REQUIRED",
        "The private-site confirmation is missing, expired or already consumed.",
      );
    }
    const matches =
      pending.taskId === task.taskId &&
      pending.ownerScopeHash === task.ownerScopeHash &&
      pending.siteId === policy.siteId &&
      pending.purpose === purpose;
    if (!matches) {
      throw new AppError(
        "SITE_ACCESS_AUTHORIZATION_REQUIRED",
        "The private-site confirmation does not match this task and purpose.",
      );
    }
    this.pending.delete(confirmationId);
    const expiresAt = new Date(
      Math.min(Date.parse(task.expiresAt), Date.now() + GRANT_TTL_MS),
    ).toISOString();
    const grant: BrowserSiteGrant = {
      taskId: task.taskId,
      ownerScopeHash: task.ownerScopeHash,
      siteId: policy.siteId,
      allowedOrigins: [...policy.allowedOrigins],
      expiresAt,
    };
    this.grants.set(grantKey(task.taskId, policy.siteId), grant);
    return cloneGrant(grant);
  }

  requireGrant(
    task: BrowserTask,
    policy: AuthorizedSitePolicy,
  ): BrowserSiteGrant {
    this.pruneExpiredConfirmations();
    const key = grantKey(task.taskId, policy.siteId);
    const grant = this.grants.get(key);
    if (!grant) {
      throw new AppError(
        "SITE_ACCESS_AUTHORIZATION_REQUIRED",
        "Use browser_open_authorized_site and confirm access before opening this private site.",
      );
    }
    if (grant.ownerScopeHash !== task.ownerScopeHash) {
      throw new AppError(
        "TASK_OWNERSHIP_MISMATCH",
        "The private-site grant belongs to another owner scope.",
      );
    }
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      this.grants.delete(key);
      throw new AppError(
        "SITE_ACCESS_GRANT_EXPIRED",
        "The private-site grant has expired.",
      );
    }
    return cloneGrant(grant);
  }

  grantForTaskSite(
    taskId: string,
    siteId: string,
  ): BrowserSiteGrant | undefined {
    this.pruneExpired();
    const grant = this.grants.get(grantKey(taskId, siteId));
    return grant ? cloneGrant(grant) : undefined;
  }

  revokeTaskSite(taskId: string, siteId: string): BrowserSiteGrant | undefined {
    const key = grantKey(taskId, siteId);
    const grant = this.grants.get(key);
    if (!grant) return undefined;
    this.grants.delete(key);
    return cloneGrant(grant);
  }

  revokeTask(taskId: string): BrowserSiteGrant[] {
    const revoked: BrowserSiteGrant[] = [];
    for (const [key, grant] of this.grants) {
      if (grant.taskId !== taskId) continue;
      revoked.push(cloneGrant(grant));
      this.grants.delete(key);
    }
    for (const [confirmationId, pending] of this.pending) {
      if (pending.taskId === taskId) this.pending.delete(confirmationId);
    }
    return revoked;
  }

  activeGrants(): BrowserSiteGrant[] {
    this.pruneExpired();
    return [...this.grants.values()].map(cloneGrant);
  }

  private pruneExpired(now = Date.now()): void {
    this.pruneExpiredConfirmations(now);
    this.pruneExpiredGrants(now);
  }

  private pruneExpiredConfirmations(now = Date.now()): void {
    for (const [confirmationId, pending] of this.pending) {
      if (Date.parse(pending.expiresAt) <= now) this.pending.delete(confirmationId);
    }
  }

  private pruneExpiredGrants(now = Date.now()): void {
    for (const [key, grant] of this.grants) {
      if (Date.parse(grant.expiresAt) <= now) this.grants.delete(key);
    }
  }
}

function grantKey(taskId: string, siteId: string): string {
  return `${taskId}\u0000${siteId}`;
}

function cloneGrant(grant: BrowserSiteGrant): BrowserSiteGrant {
  return { ...grant, allowedOrigins: [...grant.allowedOrigins] };
}
