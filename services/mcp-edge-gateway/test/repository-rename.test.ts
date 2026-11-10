import { describe, expect, it } from "@jest/globals";
import { EdgeAccountStore, type AccountStorage } from "../src/control-plane/account-store.js";
import { EdgeRepositoryControlPlane } from "../src/control-plane/repository-control-plane.js";

class MemoryStorage implements AccountStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("repository logical name CAS", () => {
  it("validates without mutation and renames only owner metadata while retaining all IDs and locations", async () => {
    const accounts = new EdgeAccountStore(new MemoryStorage());
    const owner = await accounts.createSingleUserIdentity("Owner");
    const original = await accounts.createRepository(owner.id, "ciclo");
    await accounts.createRepository(owner.id, "other");
    const device = await accounts.registerDevice(owner.id, { displayName: "PC", platform: "windows" });
    const mat = await accounts.upsertMaterialization(owner.id, device.id, {
      repositoryId: original.id, workspaceId: "recontei-app",
      path: "C:/Project/Recontei App", platform: "windows",
    });
    const remote = await accounts.upsertRuntimeMaterialization(
      owner.id, "rt_11111111-1111-4111-8111-111111111111", {
        repositoryId: original.id, workspaceId: "ciclo-remote-dc724897",
        path: "/var/lib/mcp-access-stack/edge-connector/repositories/ciclo-cacd044a",
        platform: "linux",
      },
    );
    const control = new EdgeRepositoryControlPlane(accounts, {
      isDeviceOnline: () => true, isRemoteRuntimeOnline: () => true,
    });
    const principal = {
      subject: `user:${owner.id}`, scopes: ["workspaces:read"], ownerScope: "owner" as const, userId: owner.id,
    };
    const args = { repositoryId: original.id, expectedName: "ciclo", targetName: "recontei-app" };
    const preview = await control.handle(toolCall(101, "rename_repository", args), principal);
    expect(await preview!.json()).toMatchObject({
      result: { structuredContent: {
        status: "validated", repositoryId: original.id,
        before: { name: "ciclo" }, after: { name: "recontei-app" },
      } },
    });
    expect((await accounts.getRepositoryForUser(owner.id, original.id))?.repository.name).toBe("ciclo");
    const applied = await control.handle(toolCall(102, "rename_repository", { ...args, mode: "apply" }), principal);
    expect(await applied!.json()).toMatchObject({ result: { structuredContent: { status: "completed" } } });
    expect(await control.readRepositoryDetails(owner.id, original.id)).toMatchObject({
      id: original.id, name: "recontei-app",
      materializations: [
        { id: mat.id, workspaceId: "recontei-app", path: "C:/Project/Recontei App" },
        { id: remote.id, workspaceId: "ciclo-remote-dc724897", path: "/var/lib/mcp-access-stack/edge-connector/repositories/ciclo-cacd044a" },
      ],
    });
    const stale = await control.handle(toolCall(103, "rename_repository", { ...args, mode: "apply" }), principal);
    expect(await stale!.json()).toMatchObject({ result: { isError: true } });
    const conflict = await control.handle(toolCall(104, "rename_repository", {
      repositoryId: original.id, expectedName: "recontei-app", targetName: "other", mode: "apply",
    }), principal);
    expect(await conflict!.json()).toMatchObject({ result: { isError: true } });
    expect((await accounts.getRepositoryForUser(owner.id, original.id))?.repository.name).toBe("recontei-app");
  });

  it("denies another user from renaming an owned repository", async () => {
    const accounts = new EdgeAccountStore(new MemoryStorage());
    const owner = await accounts.createSingleUserIdentity("Owner");
    const original = await accounts.createRepository(owner.id, "ciclo");
    await expect(accounts.renameOwnedRepository(
      "usr_22222222-2222-4222-8222-222222222222",
      original.id, "ciclo", "recontei-app", false,
    )).rejects.toThrow("not owned");
    expect((await accounts.getRepositoryForUser(owner.id, original.id))?.repository.name).toBe("ciclo");
  });
});
