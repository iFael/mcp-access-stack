import { describe, expect, it, jest } from "@jest/globals";
import { EdgeAccountStore, type AccountStorage } from "../src/control-plane/account-store.js";
import { EdgeRepositoryControlPlane } from "../src/control-plane/repository-control-plane.js";

class MemoryStorage implements AccountStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
}

describe("Repository identity and ACL control plane", () => {
  it("keeps private repositories isolated by individual user identity", async () => {
    const storage = new MemoryStorage();
    const accounts = new EdgeAccountStore(storage);
    const rafael = await accounts.createUser("Rafael", "rafael-pass");
    const felipe = await accounts.createUser("Felipe", "felipe-pass");
    const repo = await accounts.createRepository(rafael.id, "privado");

    expect(await accounts.getRepositoryForUser(rafael.id, repo.id)).not.toBeNull();
    expect(await accounts.getRepositoryForUser(felipe.id, repo.id)).toBeNull();

    const control = new EdgeRepositoryControlPlane(accounts, {
      isDeviceOnline: () => false,
    });
    const response = await control.handle(toolCall(1, "get_repository", { repositoryId: repo.id }), {
      subject: `user:${felipe.id}`,
      scopes: ["workspaces:read"],
      ownerScope: "owner",
      userId: felipe.id,
    });
    expect(response).not.toBeNull();
    expect(await response!.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("REPOSITORY_NOT_FOUND") }],
      },
    });
  });

  it("tracks device lifecycle without exposing another user's device", async () => {
    const storage = new MemoryStorage();
    const accounts = new EdgeAccountStore(storage);
    const rafael = await accounts.createUser("Rafael", "rafael-pass");
    const felipe = await accounts.createUser("Felipe", "felipe-pass");
    const device = await accounts.registerDevice(rafael.id, {
      displayName: "PC Trabalho",
      platform: "windows",
    });

    expect((await accounts.listDevices(rafael.id)).map((value) => value.id)).toEqual([device.id]);
    expect(await accounts.listDevices(felipe.id)).toEqual([]);
    expect(await accounts.revokeDevice(felipe.id, device.id)).toBeNull();
    expect((await accounts.revokeDevice(rafael.id, device.id))?.revokedAt).toBeDefined();
  });

  it("revokes only the caller device and disconnects its active presence", async () => {
    const storage = new MemoryStorage();
    const accounts = new EdgeAccountStore(storage);
    const rafael = await accounts.createUser("Rafael", "rafael-pass");
    const felipe = await accounts.createUser("Felipe", "felipe-pass");
    const device = await accounts.registerDevice(rafael.id, {
      displayName: "PC Trabalho",
      platform: "windows",
    });
    const online = new Set([device.id]);
    const disconnectDevice = jest.fn((deviceId: string) => {
      online.delete(deviceId);
    });
    const control = new EdgeRepositoryControlPlane(accounts, {
      isDeviceOnline: (deviceId) => online.has(deviceId),
      disconnectDevice,
    });

    const rafaelPrincipal = {
      subject: `user:${rafael.id}`,
      scopes: ["workspaces:read"],
      ownerScope: "owner" as const,
      userId: rafael.id,
    };
    const felipePrincipal = {
      subject: `user:${felipe.id}`,
      scopes: ["workspaces:read"],
      ownerScope: "owner" as const,
      userId: felipe.id,
    };

    const before = await control.handle(
      toolCall(10, "list_devices", {}),
      rafaelPrincipal,
    );
    expect(await before!.json()).toMatchObject({
      result: {
        structuredContent: {
          devices: [expect.objectContaining({ id: device.id, status: "online" })],
        },
      },
    });

    const denied = await control.handle(
      toolCall(11, "revoke_device", { deviceId: device.id }),
      felipePrincipal,
    );
    expect(await denied!.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("DEVICE_NOT_FOUND") }],
      },
    });
    expect(disconnectDevice).not.toHaveBeenCalled();

    const revoked = await control.handle(
      toolCall(12, "revoke_device", { deviceId: device.id }),
      rafaelPrincipal,
    );
    expect(await revoked!.json()).toMatchObject({
      result: {
        structuredContent: {
          device: expect.objectContaining({ id: device.id, status: "revoked" }),
        },
      },
    });
    expect(disconnectDevice).toHaveBeenCalledTimes(1);
    expect(disconnectDevice).toHaveBeenCalledWith(device.id);
    expect(online.has(device.id)).toBe(false);

    const after = await control.handle(
      toolCall(13, "list_devices", {}),
      rafaelPrincipal,
    );
    expect(await after!.json()).toMatchObject({
      result: {
        structuredContent: {
          devices: [expect.objectContaining({ id: device.id, status: "revoked" })],
        },
      },
    });
  });

  it("keeps one materialization per device/workspace and supports exact rollback removal", async () => {
    const storage = new MemoryStorage();
    const accounts = new EdgeAccountStore(storage);
    const rafael = await accounts.createUser("Rafael", "rafael-pass");
    const felipe = await accounts.createUser("Felipe", "felipe-pass");
    const device = await accounts.registerDevice(rafael.id, {
      displayName: "PC Trabalho",
      platform: "windows",
    });
    const repository = await accounts.createRepository(
      rafael.id,
      "repo-local",
      ["https://example.invalid/repo-local.git"],
    );

    const first = await accounts.upsertMaterialization(rafael.id, device.id, {
      repositoryId: repository.id,
      workspaceId: "repo-local",
      path: "C:/Repos/repo-local",
      platform: "windows",
    });
    const updated = await accounts.upsertMaterialization(rafael.id, device.id, {
      repositoryId: repository.id,
      workspaceId: "repo-local",
      path: "C:/Repos/Repo-Local",
      platform: "windows",
    });

    expect(updated.id).toBe(first.id);
    expect(await accounts.listMaterializations(rafael.id, repository.id)).toEqual([
      expect.objectContaining({
        id: first.id,
        workspaceId: "repo-local",
        path: "C:/Repos/Repo-Local",
      }),
    ]);
    await expect(
      accounts.deleteMaterialization(felipe.id, repository.id, first.id),
    ).resolves.toBe(false);
    await expect(
      accounts.deleteMaterialization(rafael.id, repository.id, first.id),
    ).resolves.toBe(true);
    expect(await accounts.listMaterializations(rafael.id, repository.id)).toEqual([]);
    await expect(
      accounts.deleteOwnedRepositoryIfUnmaterialized(rafael.id, repository.id),
    ).resolves.toBe(true);
    expect(await accounts.getRepositoryForUser(rafael.id, repository.id)).toBeNull();
  });
});

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}
