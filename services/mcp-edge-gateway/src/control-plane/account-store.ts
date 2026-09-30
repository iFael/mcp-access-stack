export interface AccountStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type AccountUser = {
  version: 2;
  id: string;
  displayName: string;
  normalizedName: string;
  createdAt: string;
};

type LegacyAccountUser = {
  version: 1;
  id: string;
  displayName: string;
  normalizedName: string;
  passwordSalt: string;
  passwordVerifier: string;
  createdAt: string;
};

export type SingleUserIdentityMigrationInput = {
  fromUserId: string;
  toUser: {
    id: string;
    displayName: string;
    createdAt: string;
  };
};

export type SingleUserIdentityMigrationResult = {
  user: AccountUser;
  repositoryCount: number;
  deviceCount: number;
  materializationCount: number;
  alreadyMigrated: boolean;
};

export type RepositoryRole = "owner" | "editor" | "viewer";

export type StoredRepository = {
  version: 1;
  id: string;
  ownerUserId: string;
  name: string;
  normalizedName: string;
  visibility: "private" | "shared";
  remoteUrls?: string[];
  members: Array<{ userId: string; role: RepositoryRole }>;
  createdAt: string;
  updatedAt: string;
};

export type StoredDevice = {
  version: 1;
  id: string;
  userId: string;
  displayName: string;
  platform: "windows" | "linux" | "macos" | "unknown";
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type StoredMaterialization = {
  version: 1;
  id: string;
  repositoryId: string;
  userId: string;
  deviceId?: string;
  runtimeId?: string;
  workspaceId: string;
  path: string;
  platform: StoredDevice["platform"];
  updatedAt: string;
};

export type MaterializationUpsertInput = Omit<
  StoredMaterialization,
  "version" | "id" | "userId" | "deviceId" | "runtimeId" | "updatedAt"
> & { id?: string };

const USER_IDS_KEY = "account:user-ids:v1";
const MAX_REPOSITORIES_PER_USER = 4096;
const MAX_DEVICES_PER_USER = 256;
const MAX_MATERIALIZATIONS_PER_REPOSITORY = 256;

export class EdgeAccountStore {
  constructor(private readonly storage: AccountStorage) {}

  async countUsers(): Promise<number> {
    return (await this.storage.get<string[]>(USER_IDS_KEY))?.length ?? 0;
  }

  async listUsers(): Promise<AccountUser[]> {
    const ids = (await this.storage.get<string[]>(USER_IDS_KEY)) ?? [];
    const users: AccountUser[] = [];
    for (const id of ids) {
      const user = await this.getUser(id);
      if (user) users.push(user);
    }
    return users;
  }

  async getUser(userId: string): Promise<AccountUser | null> {
    const value = await this.storage.get<unknown>(userKey(userId));
    return toAccountUser(value);
  }

  async findUserByName(displayName: string): Promise<AccountUser | null> {
    const normalizedName = normalizeName(displayName);
    if (!normalizedName) return null;
    const userId = await this.storage.get<string>(userNameKey(normalizedName));
    return userId ? this.getUser(userId) : null;
  }

  async createSingleUserIdentity(
    displayName: string,
    options: { id?: string; createdAt?: string } = {},
  ): Promise<AccountUser> {
    const normalizedName = normalizeName(displayName);
    if (!normalizedName || normalizedName.length > 200) throw new Error("User name is invalid.");
    const ids = (await this.storage.get<string[]>(USER_IDS_KEY)) ?? [];
    if (ids.length !== 0) throw new Error("Single-user identity already exists.");
    const id = options.id ?? prefixedId("usr");
    assertUserId(id);
    const createdAt = options.createdAt ?? new Date().toISOString();
    assertTimestamp(createdAt, "User creation timestamp");
    const user: AccountUser = {
      version: 2,
      id,
      displayName: displayName.trim(),
      normalizedName,
      createdAt,
    };
    await this.storage.put(userKey(user.id), user);
    await this.storage.put(userNameKey(normalizedName), user.id);
    await this.storage.put(USER_IDS_KEY, [user.id]);
    return user;
  }

  async migrateSingleUserIdentity(
    input: SingleUserIdentityMigrationInput,
  ): Promise<SingleUserIdentityMigrationResult> {
    const transaction = storageTransaction(this.storage);
    if (transaction) {
      return transaction(async (storage) =>
        new EdgeAccountStore(storage).migrateSingleUserIdentityDirect(input));
    }
    return this.migrateSingleUserIdentityDirect(input);
  }

  private async migrateSingleUserIdentityDirect(
    input: SingleUserIdentityMigrationInput,
  ): Promise<SingleUserIdentityMigrationResult> {
    assertUserId(input.fromUserId);
    assertUserId(input.toUser.id);
    if (input.fromUserId === input.toUser.id) throw new Error("Source and target user ids must differ.");
    const displayName = input.toUser.displayName.trim();
    const normalizedName = normalizeName(displayName);
    if (!normalizedName || normalizedName.length > 200) throw new Error("Target user name is invalid.");
    assertTimestamp(input.toUser.createdAt, "Target user creation timestamp");

    const ids = (await this.storage.get<string[]>(USER_IDS_KEY)) ?? [];
    if (ids.length === 1 && ids[0] === input.toUser.id) {
      const user = await this.getUser(input.toUser.id);
      if (!user ||
          user.displayName !== displayName ||
          user.createdAt !== input.toUser.createdAt ||
          await this.getUser(input.fromUserId)) {
        throw new Error("Existing single-user identity does not match the requested migration.");
      }
      const counts = await this.identityBindingCounts(user.id);
      return { user, ...counts, alreadyMigrated: true };
    }
    if (ids.length !== 1 || ids[0] !== input.fromUserId) {
      throw new Error("Single-user migration source does not match durable account state.");
    }

    const rawSource = await this.storage.get<unknown>(userKey(input.fromUserId));
    const source = readStoredUser(rawSource);
    if (!source || source.id !== input.fromUserId) throw new Error("Source user identity is unavailable.");
    if (await this.storage.get<unknown>(userKey(input.toUser.id))) {
      throw new Error("Target user identity already exists.");
    }
    const targetNameOwner = await this.storage.get<string>(userNameKey(normalizedName));
    if (targetNameOwner && targetNameOwner !== input.fromUserId) {
      throw new Error("Target user name already belongs to another identity.");
    }

    const repositoryIds = (await this.storage.get<string[]>(userRepositoryIdsKey(input.fromUserId))) ?? [];
    const repositories: StoredRepository[] = [];
    const materializations: StoredMaterialization[] = [];
    for (const repositoryId of repositoryIds) {
      const repository = await this.storage.get<StoredRepository>(repositoryKey(repositoryId));
      if (!isRepository(repository) ||
          repository.ownerUserId !== input.fromUserId ||
          repository.visibility !== "private" ||
          repository.members.length !== 1 ||
          repository.members[0]?.userId !== input.fromUserId ||
          repository.members[0]?.role !== "owner") {
        throw new Error("Repository ownership is not compatible with single-user migration.");
      }
      repositories.push(repository);
      const materializationIds =
        (await this.storage.get<string[]>(repositoryMaterializationIdsKey(repositoryId))) ?? [];
      for (const materializationId of materializationIds) {
        const materialization =
          await this.storage.get<StoredMaterialization>(materializationKey(materializationId));
        if (!isMaterialization(materialization) ||
            materialization.repositoryId !== repositoryId ||
            materialization.userId !== input.fromUserId) {
          throw new Error("Repository materialization is not compatible with single-user migration.");
        }
        materializations.push(materialization);
      }
    }

    const deviceIds = (await this.storage.get<string[]>(userDeviceIdsKey(input.fromUserId))) ?? [];
    const devices: StoredDevice[] = [];
    for (const deviceId of deviceIds) {
      const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
      if (!isDevice(device) || device.userId !== input.fromUserId) {
        throw new Error("Device ownership is not compatible with single-user migration.");
      }
      devices.push(device);
    }

    const user: AccountUser = {
      version: 2,
      id: input.toUser.id,
      displayName,
      normalizedName,
      createdAt: input.toUser.createdAt,
    };

    await this.storage.put(userKey(user.id), user);
    await this.storage.put(userNameKey(user.normalizedName), user.id);
    await this.storage.put(userRepositoryIdsKey(user.id), [...repositoryIds]);
    await this.storage.put(userDeviceIdsKey(user.id), [...deviceIds]);

    for (const repository of repositories) {
      await this.storage.put(repositoryKey(repository.id), {
        ...repository,
        ownerUserId: user.id,
        visibility: "private",
        members: [{ userId: user.id, role: "owner" }],
      } satisfies StoredRepository);
    }
    for (const materialization of materializations) {
      await this.storage.put(materializationKey(materialization.id), {
        ...materialization,
        userId: user.id,
      } satisfies StoredMaterialization);
    }
    for (const device of devices) {
      await this.storage.put(deviceKey(device.id), {
        ...device,
        userId: user.id,
      } satisfies StoredDevice);
    }

    await this.storage.put(USER_IDS_KEY, [user.id]);
    if (source.normalizedName !== user.normalizedName) {
      const sourceNameOwner = await this.storage.get<string>(userNameKey(source.normalizedName));
      if (sourceNameOwner === input.fromUserId) await this.storage.delete(userNameKey(source.normalizedName));
    }
    await this.storage.delete(userRepositoryIdsKey(input.fromUserId));
    await this.storage.delete(userDeviceIdsKey(input.fromUserId));
    await this.storage.delete(userKey(input.fromUserId));

    return {
      user,
      repositoryCount: repositories.length,
      deviceCount: devices.length,
      materializationCount: materializations.length,
      alreadyMigrated: false,
    };
  }

  private async identityBindingCounts(userId: string): Promise<{
    repositoryCount: number;
    deviceCount: number;
    materializationCount: number;
  }> {
    const repositoryIds = (await this.storage.get<string[]>(userRepositoryIdsKey(userId))) ?? [];
    let materializationCount = 0;
    for (const repositoryId of repositoryIds) {
      materializationCount +=
        ((await this.storage.get<string[]>(repositoryMaterializationIdsKey(repositoryId))) ?? []).length;
    }
    const deviceCount = ((await this.storage.get<string[]>(userDeviceIdsKey(userId))) ?? []).length;
    return { repositoryCount: repositoryIds.length, deviceCount, materializationCount };
  }

  async listRepositories(userId: string): Promise<Array<{ repository: StoredRepository; role: RepositoryRole }>> {
    const ids = (await this.storage.get<string[]>(userRepositoryIdsKey(userId))) ?? [];
    const results: Array<{ repository: StoredRepository; role: RepositoryRole }> = [];
    for (const id of ids) {
      const repository = await this.storage.get<StoredRepository>(repositoryKey(id));
      if (!isRepository(repository)) continue;
      const role = roleFor(repository, userId);
      if (!role) continue;
      results.push({ repository, role });
    }
    return results.sort((left, right) => left.repository.name.localeCompare(right.repository.name));
  }

  async getRepositoryForUser(userId: string, repositoryId: string): Promise<{ repository: StoredRepository; role: RepositoryRole } | null> {
    const repository = await this.storage.get<StoredRepository>(repositoryKey(repositoryId));
    if (!isRepository(repository)) return null;
    const role = roleFor(repository, userId);
    return role ? { repository, role } : null;
  }

  async createRepository(userId: string, name: string, remoteUrls: string[] = []): Promise<StoredRepository> {
    if (!(await this.getUser(userId))) throw new Error("User identity is unavailable.");
    const normalizedName = normalizeRepositoryName(name);
    if (!normalizedName) throw new Error("Repository name is invalid.");
    const ids = (await this.storage.get<string[]>(userRepositoryIdsKey(userId))) ?? [];
    if (ids.length >= MAX_REPOSITORIES_PER_USER) throw new Error("Repository limit reached.");
    for (const id of ids) {
      const existing = await this.storage.get<StoredRepository>(repositoryKey(id));
      if (isRepository(existing) && existing.ownerUserId === userId && existing.normalizedName === normalizedName) {
        throw new Error("A repository with this name already exists.");
      }
    }
    const now = new Date().toISOString();
    const repository: StoredRepository = {
      version: 1,
      id: prefixedId("repo"),
      ownerUserId: userId,
      name: name.trim(),
      normalizedName,
      visibility: "private",
      remoteUrls: normalizeRemoteUrls(remoteUrls),
      members: [{ userId, role: "owner" }],
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.put(repositoryKey(repository.id), repository);
    await this.storage.put(userRepositoryIdsKey(userId), [...ids, repository.id]);
    return repository;
  }

  async findMaterializationByDevicePath(
    userId: string,
    deviceId: string,
    materializationPath: string,
  ): Promise<{ repository: StoredRepository; role: RepositoryRole; materialization: StoredMaterialization } | null> {
    const repositories = await this.listRepositories(userId);
    for (const access of repositories) {
      const ids =
        (await this.storage.get<string[]>(repositoryMaterializationIdsKey(access.repository.id))) ?? [];
      for (const id of ids) {
        const materialization = await this.storage.get<StoredMaterialization>(materializationKey(id));
        if (!isMaterialization(materialization) ||
            materialization.userId !== userId ||
            materialization.deviceId !== deviceId ||
            materialization.path !== materializationPath) continue;
        return { ...access, materialization };
      }
    }
    return null;
  }

  async deleteOwnedRepositoryIfUnmaterialized(
    userId: string,
    repositoryId: string,
  ): Promise<boolean> {
    const access = await this.getRepositoryForUser(userId, repositoryId);
    if (!access || access.role !== "owner" || access.repository.ownerUserId !== userId) return false;

    const materializationIds =
      (await this.storage.get<string[]>(repositoryMaterializationIdsKey(repositoryId))) ?? [];
    for (const id of materializationIds) {
      const value = await this.storage.get<StoredMaterialization>(materializationKey(id));
      if (isMaterialization(value)) return false;
    }

    await removeValue(this.storage, userRepositoryIdsKey(userId), repositoryId);
    await this.storage.delete(repositoryMaterializationIdsKey(repositoryId));
    return this.storage.delete(repositoryKey(repositoryId));
  }

  async registerDevice(
    userId: string,
    input: { deviceId?: string; displayName: string; platform: StoredDevice["platform"] },
  ): Promise<StoredDevice> {
    if (!(await this.getUser(userId))) throw new Error("User identity is unavailable.");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 200) throw new Error("Device name is invalid.");
    if (input.deviceId) {
      const existing = await this.storage.get<StoredDevice>(deviceKey(input.deviceId));
      if (isDevice(existing) && existing.userId === userId && !existing.revokedAt) {
        const updated: StoredDevice = {
          ...existing,
          displayName,
          platform: input.platform,
          lastSeenAt: new Date().toISOString(),
        };
        await this.storage.put(deviceKey(existing.id), updated);
        return updated;
      }
    }
    const ids = (await this.storage.get<string[]>(userDeviceIdsKey(userId))) ?? [];
    if (ids.length >= MAX_DEVICES_PER_USER) throw new Error("Device limit reached.");
    const now = new Date().toISOString();
    const device: StoredDevice = {
      version: 1,
      id: prefixedId("dev"),
      userId,
      displayName,
      platform: input.platform,
      createdAt: now,
      lastSeenAt: now,
    };
    await this.storage.put(deviceKey(device.id), device);
    await this.storage.put(userDeviceIdsKey(userId), [...ids, device.id]);
    return device;
  }

  async touchDevice(userId: string, deviceId: string): Promise<StoredDevice | null> {
    const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
    if (!isDevice(device) || device.userId !== userId || device.revokedAt) return null;
    const updated = { ...device, lastSeenAt: new Date().toISOString() };
    await this.storage.put(deviceKey(deviceId), updated);
    return updated;
  }

  async getActiveDeviceForUser(
    userId: string,
    deviceId: string,
  ): Promise<StoredDevice | null> {
    const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
    return isDevice(device) && device.userId === userId && !device.revokedAt
      ? device
      : null;
  }

  async listDevices(userId: string): Promise<StoredDevice[]> {
    const ids = (await this.storage.get<string[]>(userDeviceIdsKey(userId))) ?? [];
    const devices: StoredDevice[] = [];
    for (const id of ids) {
      const device = await this.storage.get<StoredDevice>(deviceKey(id));
      if (isDevice(device)) devices.push(device);
    }
    return devices.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<StoredDevice | null> {
    const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
    if (!isDevice(device) || device.userId !== userId) return null;
    const revoked: StoredDevice = { ...device, revokedAt: device.revokedAt ?? new Date().toISOString() };
    await this.storage.put(deviceKey(deviceId), revoked);
    return revoked;
  }

  async upsertMaterialization(
    userId: string,
    deviceId: string,
    input: MaterializationUpsertInput,
  ): Promise<StoredMaterialization> {
    const repositoryAccess = await this.getRepositoryForUser(userId, input.repositoryId);
    if (!repositoryAccess) throw new Error("Repository is not authorized for this user.");
    const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
    if (!isDevice(device) || device.userId !== userId || device.revokedAt) throw new Error("Device is not authorized.");

    const ids = (await this.storage.get<string[]>(repositoryMaterializationIdsKey(input.repositoryId))) ?? [];
    let existing: StoredMaterialization | undefined;
    if (input.id) existing = await this.storage.get<StoredMaterialization>(materializationKey(input.id));
    if (!existing) {
      existing = await findMaterialization(this.storage, ids, deviceId, input.workspaceId);
    }
    const materialization: StoredMaterialization = {
      version: 1,
      id: existing?.id ?? prefixedId("mat"),
      repositoryId: input.repositoryId,
      userId,
      deviceId,
      workspaceId: input.workspaceId,
      path: input.path,
      platform: input.platform,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put(materializationKey(materialization.id), materialization);
    if (!ids.includes(materialization.id)) {
      if (ids.length >= MAX_MATERIALIZATIONS_PER_REPOSITORY) throw new Error("Materialization limit reached.");
      await this.storage.put(repositoryMaterializationIdsKey(input.repositoryId), [...ids, materialization.id]);
    }
    return materialization;
  }

  async upsertRuntimeMaterialization(
    userId: string,
    runtimeId: string,
    input: MaterializationUpsertInput,
  ): Promise<StoredMaterialization> {
    const repositoryAccess = await this.getRepositoryForUser(userId, input.repositoryId);
    if (!repositoryAccess) throw new Error("Repository is not authorized for this user.");
    if (!/^rt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runtimeId)) {
      throw new Error("Runtime id is invalid.");
    }

    const ids = (await this.storage.get<string[]>(repositoryMaterializationIdsKey(input.repositoryId))) ?? [];
    let existing: StoredMaterialization | undefined;
    if (input.id) {
      const candidate = await this.storage.get<StoredMaterialization>(materializationKey(input.id));
      if (isMaterialization(candidate) && candidate.userId === userId && candidate.repositoryId === input.repositoryId) {
        existing = candidate;
      }
    }
    if (!existing) {
      existing = await findRuntimeMaterialization(this.storage, ids, runtimeId, input.workspaceId);
    }
    const materialization: StoredMaterialization = {
      version: 1,
      id: existing?.id ?? prefixedId("mat"),
      repositoryId: input.repositoryId,
      userId,
      runtimeId,
      workspaceId: input.workspaceId,
      path: input.path,
      platform: input.platform,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put(materializationKey(materialization.id), materialization);
    if (!ids.includes(materialization.id)) {
      if (ids.length >= MAX_MATERIALIZATIONS_PER_REPOSITORY) throw new Error("Materialization limit reached.");
      await this.storage.put(repositoryMaterializationIdsKey(input.repositoryId), [...ids, materialization.id]);
    }
    return materialization;
  }

  async listMaterializations(userId: string, repositoryId: string): Promise<StoredMaterialization[]> {
    if (!(await this.getRepositoryForUser(userId, repositoryId))) return [];
    const ids = (await this.storage.get<string[]>(repositoryMaterializationIdsKey(repositoryId))) ?? [];
    const values: StoredMaterialization[] = [];
    for (const id of ids) {
      const value = await this.storage.get<StoredMaterialization>(materializationKey(id));
      if (isMaterialization(value)) values.push(value);
    }
    return values;
  }

  async reconcileDeviceMaterializations(
    userId: string,
    deviceId: string,
    desired: MaterializationUpsertInput[],
  ): Promise<StoredMaterialization[]> {
    const device = await this.storage.get<StoredDevice>(deviceKey(deviceId));
    if (!isDevice(device) || device.userId !== userId || device.revokedAt) {
      throw new Error("Device is not authorized.");
    }

    const desiredKeys = new Set<string>();
    for (const input of desired) {
      const key = materializationIdentityKey(input.repositoryId, input.workspaceId);
      if (desiredKeys.has(key)) {
        throw new Error("Duplicate repository materialization announcement.");
      }
      desiredKeys.add(key);
      if (!(await this.getRepositoryForUser(userId, input.repositoryId))) {
        throw new Error("Repository is not authorized for this user.");
      }
    }

    const repositories = await this.listRepositories(userId);
    for (const { repository } of repositories) {
      const current = await this.listMaterializations(userId, repository.id);
      for (const materialization of current) {
        if (materialization.deviceId !== deviceId) continue;
        const key = materializationIdentityKey(
          materialization.repositoryId,
          materialization.workspaceId,
        );
        if (!desiredKeys.has(key)) {
          await this.deleteMaterialization(
            userId,
            materialization.repositoryId,
            materialization.id,
          );
        }
      }
    }

    const reconciled: StoredMaterialization[] = [];
    for (const input of desired) {
      reconciled.push(await this.upsertMaterialization(userId, deviceId, input));
    }
    return reconciled;
  }

  async deleteMaterialization(
    userId: string,
    repositoryId: string,
    materializationId: string,
  ): Promise<boolean> {
    if (!(await this.getRepositoryForUser(userId, repositoryId))) return false;
    const value = await this.storage.get<StoredMaterialization>(
      materializationKey(materializationId),
    );
    if (!isMaterialization(value) ||
        value.userId !== userId ||
        value.repositoryId !== repositoryId) {
      return false;
    }
    await this.storage.delete(materializationKey(materializationId));
    await removeValue(
      this.storage,
      repositoryMaterializationIdsKey(repositoryId),
      materializationId,
    );
    return true;
  }
}

function prefixedId(prefix: "usr" | "repo" | "dev" | "mat"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function storageTransaction(
  storage: AccountStorage,
): (<T>(closure: (transaction: AccountStorage) => Promise<T>) => Promise<T>) | null {
  const transaction = (storage as { transaction?: unknown }).transaction;
  if (typeof transaction !== "function") return null;
  return transaction.bind(storage) as
    <T>(closure: (transaction: AccountStorage) => Promise<T>) => Promise<T>;
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeRepositoryName(value: string): string {
  const normalized = normalizeName(value);
  if (!normalized || normalized.length > 200 || /[\0\r\n/\\]/u.test(normalized)) return "";
  return normalized;
}

function materializationIdentityKey(
  repositoryId: string,
  workspaceId: string,
): string {
  return `${repositoryId}\u0000${workspaceId}`;
}

function userKey(id: string): string { return `account:user:${id}`; }
function userNameKey(normalized: string): string { return `account:user-name:${normalized}`; }
function userRepositoryIdsKey(userId: string): string { return `account:user-repositories:${userId}`; }
function repositoryKey(id: string): string { return `account:repository:${id}`; }
function userDeviceIdsKey(userId: string): string { return `account:user-devices:${userId}`; }
function deviceKey(id: string): string { return `account:device:${id}`; }
function repositoryMaterializationIdsKey(repositoryId: string): string { return `account:repository-materializations:${repositoryId}`; }
function materializationKey(id: string): string { return `account:materialization:${id}`; }

function roleFor(repository: StoredRepository, userId: string): RepositoryRole | null {
  return repository.ownerUserId === userId ? "owner" : null;
}

function readStoredUser(value: unknown): AccountUser | LegacyAccountUser | null {
  if (!isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.displayName !== "string" ||
      typeof value.normalizedName !== "string" ||
      typeof value.createdAt !== "string") {
    return null;
  }
  if (value.version === 2) {
    return {
      version: 2,
      id: value.id,
      displayName: value.displayName,
      normalizedName: value.normalizedName,
      createdAt: value.createdAt,
    };
  }
  if (value.version === 1 &&
      typeof value.passwordSalt === "string" &&
      typeof value.passwordVerifier === "string") {
    return value as LegacyAccountUser;
  }
  return null;
}

function toAccountUser(value: unknown): AccountUser | null {
  const stored = readStoredUser(value);
  return stored
    ? {
        version: 2,
        id: stored.id,
        displayName: stored.displayName,
        normalizedName: stored.normalizedName,
        createdAt: stored.createdAt,
      }
    : null;
}

function isRepository(value: unknown): value is StoredRepository {
  return isRecord(value) && value.version === 1 && typeof value.id === "string" &&
    typeof value.ownerUserId === "string" && typeof value.name === "string" &&
    typeof value.normalizedName === "string" && (value.visibility === "private" || value.visibility === "shared") &&
    (value.remoteUrls === undefined || (Array.isArray(value.remoteUrls) && value.remoteUrls.every((entry) => typeof entry === "string"))) &&
    Array.isArray(value.members) && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function isDevice(value: unknown): value is StoredDevice {
  return isRecord(value) && value.version === 1 && typeof value.id === "string" &&
    typeof value.userId === "string" && typeof value.displayName === "string" &&
    typeof value.platform === "string" && typeof value.createdAt === "string";
}

function isMaterialization(value: unknown): value is StoredMaterialization {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" ||
      typeof value.repositoryId !== "string" || typeof value.userId !== "string" ||
      typeof value.workspaceId !== "string" || typeof value.path !== "string" ||
      typeof value.platform !== "string" || typeof value.updatedAt !== "string") {
    return false;
  }
  const hasDevice = typeof value.deviceId === "string";
  const hasRuntime = typeof value.runtimeId === "string";
  return hasDevice !== hasRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUserId(value: string): void {
  if (!/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("User id is invalid.");
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}

function normalizeRemoteUrls(values: string[]): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value));
  return [...new Set(normalized)].slice(0, 32);
}

async function removeValue(storage: AccountStorage, key: string, value: string): Promise<void> {
  const values = (await storage.get<string[]>(key)) ?? [];
  if (!values.includes(value)) return;
  await storage.put(key, values.filter((entry) => entry !== value));
}

async function findMaterialization(
  storage: AccountStorage,
  ids: string[],
  deviceId: string,
  workspaceId: string,
): Promise<StoredMaterialization | undefined> {
  for (const id of ids) {
    const value = await storage.get<StoredMaterialization>(materializationKey(id));
    if (isMaterialization(value) && value.deviceId === deviceId && value.workspaceId === workspaceId) return value;
  }
  return undefined;
}

async function findRuntimeMaterialization(
  storage: AccountStorage,
  ids: string[],
  runtimeId: string,
  workspaceId: string,
): Promise<StoredMaterialization | undefined> {
  for (const id of ids) {
    const value = await storage.get<StoredMaterialization>(materializationKey(id));
    if (isMaterialization(value) && value.runtimeId === runtimeId && value.workspaceId === workspaceId) return value;
  }
  return undefined;
}
