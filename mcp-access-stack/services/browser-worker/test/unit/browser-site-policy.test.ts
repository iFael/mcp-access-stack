import { describe, expect, it } from "@jest/globals";
import {
  BrowserSitePolicyRegistry,
  authorizedSitePolicySchema,
  deriveProductionOrigin,
  isAuthorizedSiteRequestAllowed,
  isAuthorizedSiteSemanticActionAllowed,
} from "../../domain/authorized-site-policy.js";
import { BrowserSiteGrantRegistry } from "../../domain/browser-site-grant-registry.js";
import type { BrowserTask } from "../../domain/browser-task-registry.js";

const policy = {
  siteId: "private-dev",
  entryUrl: "https://dev-private.example/app",
  allowedOrigins: ["https://dev-private.example"],
  deniedOrigins: ["https://private.example"],
  accessMode: "business-read-only" as const,
  loginStrategy: "none" as const,
};

const task: BrowserTask = {
  taskId: "task-a",
  ownerScopeHash: "owner-a",
  state: "active",
  tabIds: [],
  createdAt: "2026-08-02T00:00:00.000Z",
  lastActivityAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2099-08-02T00:10:00.000Z",
  lifecycleVersion: 2,
};

describe("BrowserSitePolicyRegistry", () => {
  it("classifies public, private and permanently denied origins", () => {
    const registry = new BrowserSitePolicyRegistry([policy]);

    expect(registry.classify("https://public.example/")).toEqual({
      kind: "public",
      origin: "https://public.example",
    });
    expect(registry.classify("https://dev-private.example/report")).toMatchObject({
      kind: "private",
      origin: "https://dev-private.example",
      policy: { siteId: "private-dev" },
    });
    expect(registry.classify("https://private.example/")).toEqual({
      kind: "denied",
      origin: "https://private.example",
    });
  });


  it("requires an exact request rule and semantic permit for qualified POSTs", () => {
    const strict = authorizedSitePolicySchema.parse({
      ...policy,
      requestPolicy: {
        rules: [
          {
            methods: ["GET"],
            pathname: "/LegacySite.asp",
            queryKeys: ["CTRL", "R"],
            resourceTypes: ["document"],
            navigation: true,
            requiresSemanticPermit: false,
          },
          {
            methods: ["POST"],
            pathname: "/LegacySite.asp",
            queryKeys: ["CTRL", "R"],
            resourceTypes: ["document"],
            frames: ["MenuContent"],
            navigation: true,
            requiresSemanticPermit: true,
          },
        ],
        semanticActions: [{
          operation: "frame-sequence-click",
          framePath: ["MenuContent"],
          selector: ".finc-fila-filter-refresh",
        }],
      },
    });
    const base = {
      origin: "https://dev-private.example",
      pathname: "/LegacySite.asp",
      queryKeys: ["R", "CTRL"],
      resourceType: "document",
      frame: "MenuContent",
      navigation: true,
    };

    expect(isAuthorizedSiteRequestAllowed(strict, {
      ...base,
      method: "GET",
      semanticPermit: false,
    })).toBe(true);
    expect(isAuthorizedSiteRequestAllowed(strict, {
      ...base,
      method: "POST",
      semanticPermit: false,
    })).toBe(false);
    expect(isAuthorizedSiteRequestAllowed(strict, {
      ...base,
      method: "POST",
      semanticPermit: true,
    })).toBe(true);
    expect(isAuthorizedSiteRequestAllowed(strict, {
      ...base,
      method: "POST",
      queryKeys: ["CTRL", "R", "extra"],
      semanticPermit: true,
    })).toBe(false);
    expect(isAuthorizedSiteRequestAllowed(strict, {
      ...base,
      origin: "https://external.example",
      method: "GET",
      semanticPermit: false,
    })).toBe(false);
    expect(isAuthorizedSiteSemanticActionAllowed(strict, {
      operation: "frame-sequence-click",
      framePath: ["MenuContent"],
      selector: ".finc-fila-filter-refresh",
    })).toBe(true);
    expect(isAuthorizedSiteSemanticActionAllowed(strict, {
      operation: "frame-sequence-click",
      framePath: ["MenuContent"],
      selector: ".unknown-action",
    })).toBe(false);
  });

  it("derives the production origin only from a dev-prefixed hostname", () => {
    expect(
      deriveProductionOrigin(new URL("https://dev-private.example/app")),
    ).toBe("https://private.example");
    expect(
      deriveProductionOrigin(new URL("https://private.example/app")),
    ).toBeUndefined();
  });
});

describe("BrowserSiteGrantRegistry", () => {
  it("binds a one-time confirmation to task, owner, site and purpose", () => {
    const registry = new BrowserSiteGrantRegistry();
    const pending = registry.createConfirmation(task, policy, "read-report");

    expect(() => registry.confirm(
      pending.confirmationId,
      task,
      policy,
      "different-purpose",
    )).toThrow(expect.objectContaining({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    }));

    const grant = registry.confirm(
      pending.confirmationId,
      task,
      policy,
      "read-report",
    );
    expect(grant).toMatchObject({
      taskId: task.taskId,
      ownerScopeHash: task.ownerScopeHash,
      siteId: policy.siteId,
      allowedOrigins: policy.allowedOrigins,
    });
    expect(registry.requireGrant(task, policy)).toMatchObject({
      taskId: task.taskId,
      siteId: policy.siteId,
    });
    expect(() => registry.confirm(
      pending.confirmationId,
      task,
      policy,
      "read-report",
    )).toThrow(expect.objectContaining({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    }));
  });

  it("returns an explicit expired-grant error before removing the grant", () => {
    const registry = new BrowserSiteGrantRegistry();
    const expiringTask = {
      ...task,
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const pending = registry.createConfirmation(
      expiringTask,
      policy,
      "read-report",
    );
    registry.confirm(
      pending.confirmationId,
      expiringTask,
      policy,
      "read-report",
    );

    expect(() => registry.requireGrant(expiringTask, policy)).toThrow(
      expect.objectContaining({ code: "SITE_ACCESS_GRANT_EXPIRED" }),
    );
    expect(() => registry.requireGrant(expiringTask, policy)).toThrow(
      expect.objectContaining({ code: "SITE_ACCESS_AUTHORIZATION_REQUIRED" }),
    );
  });

  it("rejects confirmation reuse across owners and revokes task grants", () => {
    const registry = new BrowserSiteGrantRegistry();
    const pending = registry.createConfirmation(task, policy, "read-report");
    const otherOwner = { ...task, ownerScopeHash: "owner-b" };

    expect(() => registry.confirm(
      pending.confirmationId,
      otherOwner,
      policy,
      "read-report",
    )).toThrow(expect.objectContaining({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    }));

    registry.confirm(pending.confirmationId, task, policy, "read-report");
    expect(registry.revokeTask(task.taskId)).toHaveLength(1);
    expect(() => registry.requireGrant(task, policy)).toThrow(
      expect.objectContaining({ code: "SITE_ACCESS_AUTHORIZATION_REQUIRED" }),
    );
  });
});
