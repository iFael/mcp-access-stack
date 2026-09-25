export interface AccountStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type AccountUser = {
  version: 1;
  id: string;
  displayName: string;
  normalizedName: string;
  passwordSalt: string;
  passwordVerifier: string;
  createdAt: string;
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
  deviceId: string;
  workspaceId: string;
  path: string;
  platform: StoredDevice["platform"];
  updatedAt: string;
};

export type MaterializationUpsertInput = Omit<
  StoredMaterialization,
  "version" | "id" | "userId" | "deviceId" | "updatedAt"
> & { id?: string };

const USER_IDS_KEY = "account:user-ids:v1";
const PBKDF2_ITERATIONS = 120_000;
const MAX_USERS = 1024;
const MAX_REPOSITORIES_PER_USER = 4096;
const MAX_DEVICES_PER_USER = 256;
const MAX_MATERIALIZATIONS_PER_REPOSITORY = 256;

export class EdgeAccountStore {
  constructor(private readonly storage: AccountStorage) {}

  async countUsers(): Promise<number> {
    return (await this.storage.get<string[]>(USER_IDS_KEY))?.length ?? 0;
  }

  async getUser(userId: string): Promise<AccountUser | null> {
    const value = await this.storage.get<AccountUser>(userKey(userId));
    return isUser(value) ? value : null;
  }

  async findUserByName(displayName: string): Promise<AccountUser | null> {
    const normalizedName = normalizeName(displayName);
    if (!normalizedName) return null;
    const userId = await this.storage.get<string>(userNameKey(normalizedName));
    return userId ? this.getUser(userId) : null;
  }

  async createUser(displayName: string, password: string): Promise<AccountUser> {
    const normalizedName = normalizeName(displayName);
    if (!normalizedName || normalizedName.length > 200) throw new Error("User name is invalid.");
    assertPassword(password);
    if (await this.findUserByName(displayName)) throw new Error("User name already exists.");

    const ids = (await this.storage.get<string[]>(USER_IDS_KEY)) ?? [];
    if (ids.length >= MAX_USERS) throw new Error("User limit reached.");

    const salt = randomBytes(16);
    const verifier = await derivePasswordVerifier(password, salt);
    const user: AccountUser = {
      version: 1,
      id: prefixedId("usr"),
      displayName: displayName.trim(),
      normalizedName,
      passwordSalt: base64UrlBytes(salt),
      passwordVerifier: verifier,
      createdAt: new Date().toISOString(),
    };
    await this.storage.put(userKey(user.id), user);
    await this.storage.put(userNameKey(normalizedName), user.id);
    await this.storage.put(USER_IDS_KEY, [...ids, user.id]);
    return user;
  }

  async authenticateUser(displayName: string, password: string): Promise<AccountUser | null> {
    const user = await this.findUserByName(displayName);
    if (!user) {
      await derivePasswordVerifier(password, randomBytes(16)).catch(() => "");
      return null;
    }
    assertPassword(password);
    const actual = await derivePasswordVerifier(password, decodeBase64UrlBytes(user.passwordSalt));
    return constantTimeEquals(actual, user.passwordVerifier) ? user : null;
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

    for (const member of access.repository.members) {
      await removeValue(this.storage, userRepositoryIdsKey(member.userId), repositoryId);
    }
    await this.storage.delete(repositoryMaterializationIdsKey(repositoryId));
    return this.storage.delete(repositoryKey(repositoryId));
  }

  async addRepositoryMember(repositoryId: string, actorUserId: string, memberUserId: string, role: Exclude<RepositoryRole, "owner">): Promise<StoredRepository> {
    const current = await this.getRepositoryForUser(actorUserId, repositoryId);
    if (!current || current.role !== "owner") throw new Error("Repository owner permission is required.");
    if (!(await this.getUser(memberUserId))) throw new Error("Repository member user does not exist.");
    const repository = current.repository;
    const members = repository.members.filter((member) => member.userId !== memberUserId);
    members.push({ userId: memberUserId, role });
    const updated: StoredRepository = {
      ...repository,
      visibility: members.length > 1 ? "shared" : "private",
      members,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put(repositoryKey(repositoryId), updated);
    await addUnique(this.storage, userRepositoryIdsKey(memberUserId), repositoryId, MAX_REPOSITORIES_PER_USER);
    return updated;
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
  return repository.members.find((member) => member.userId === userId)?.role ?? null;
}

function isUser(value: unknown): value is AccountUser {
  return isRecord(value) && value.version === 1 && typeof value.id === "string" &&
    typeof value.displayName === "string" && typeof value.normalizedName === "string" &&
    typeof value.passwordSalt === "string" && typeof value.passwordVerifier === "string" &&
    typeof value.createdAt === "string";
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
  return isRecord(value) && value.version === 1 && typeof value.id === "string" &&
    typeof value.repositoryId === "string" && typeof value.userId === "string" &&
    typeof value.deviceId === "string" && typeof value.workspaceId === "string" &&
    typeof value.path === "string" && typeof value.platform === "string" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPassword(value: string): void {
  if (value.length === 0 || value.length > 2048 || /[\r\n\0]/u.test(value)) {
    throw new Error("User password is invalid.");
  }
}

async function derivePasswordVerifier(password: string, salt: Uint8Array): Promise<string> {
  assertPassword(password);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return base64UrlBytes(new Uint8Array(bits));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
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

async function addUnique(storage: AccountStorage, key: string, value: string, limit: number): Promise<void> {
  const values = (await storage.get<string[]>(key)) ?? [];
  if (values.includes(value)) return;
  if (values.length >= limit) throw new Error("Index limit reached.");
  await storage.put(key, [...values, value]);
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
