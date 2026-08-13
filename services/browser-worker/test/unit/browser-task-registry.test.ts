import { describe, expect, it } from "@jest/globals";
import {
  BrowserTaskRegistry,
  LEGACY_UNCLAIMED_OWNER_SCOPE_HASH,
} from "../../domain/browser-task-registry.js";

describe("BrowserTaskRegistry", () => {
  it("creates, scopes and finishes one task without crossing owners", () => {
    const registry = new BrowserTaskRegistry([], 60_000);
    const owner = { ownerScope: "owner-a" };
    const task = registry.resolveForOpen(undefined, owner);
    registry.attachTab(task.taskId, "tab-a", owner);

    expect(registry.assertTabAccess("tab-a", owner).taskId).toBe(task.taskId);
    expect(() => registry.assertTabAccess("tab-a", { ownerScope: "owner-b" })).toThrow(
      expect.objectContaining({ code: "TASK_OWNERSHIP_MISMATCH" }),
    );

    registry.beginFinish(task.taskId, owner);
    registry.detachTab("tab-a");
    expect(registry.completeFinish(task.taskId)).toMatchObject({
      state: "finished",
      tabIds: [],
    });
  });

  it("requires explicit scope when one owner has multiple tasks", () => {
    const registry = new BrowserTaskRegistry([], 60_000);
    const owner = { ownerScope: "owner-a" };
    const first = registry.create(owner);
    const second = registry.create(owner);

    expect(() => registry.resolveScoped(undefined, owner)).toThrow(
      expect.objectContaining({ code: "TASK_SCOPE_REQUIRED" }),
    );
    expect(registry.resolveScoped(first.taskId, owner).taskId).toBe(first.taskId);
    expect(registry.resolveScoped(second.taskId, owner).taskId).toBe(second.taskId);
  });

  it("never auto-claims an unassigned task for the first caller", () => {
    const registry = new BrowserTaskRegistry([
      {
        taskId: "legacy-task",
        ownerScopeHash: LEGACY_UNCLAIMED_OWNER_SCOPE_HASH,
        state: "suspended",
        tabIds: ["tab-1"],
        createdAt: "2026-08-02T00:00:00.000Z",
        lastActivityAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-08-02T00:10:00.000Z",
        lifecycleVersion: 2,
      },
    ], 60_000);

    expect(registry.accessibleTasks({ ownerScope: "owner-a" })).toEqual([]);
    expect(() => registry.resolveScoped("legacy-task", { ownerScope: "owner-a" })).toThrow(
      expect.objectContaining({ code: "TASK_OWNERSHIP_MISMATCH" }),
    );
    expect(() => registry.resolveScoped("legacy-task", { ownerScope: "owner-b" })).toThrow(
      expect.objectContaining({ code: "TASK_OWNERSHIP_MISMATCH" }),
    );
  });
});
