import type { EdgeMcpCatalog, EdgeMcpToolDescriptor } from "./mcp-control-plane.js";
import { isMcpContractRevision } from "../contract-compatibility.js";

const ACTIVE_CATALOG_PREFIX = "edge:mcp-catalog:v1";
const CATALOG_CHUNK_SIZE = 4;
const MAX_CATALOG_CHUNK_BYTES = 64 * 1024;

type CatalogStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

type StoredCatalogHeaderV1 = {
  version: 1;
  contractRevision: string;
  chunkCount: number;
  toolCount: number;
  catalogMetadata: Record<string, unknown>;
  serverIdentity: { name: string; version: string };
};

export async function persistMcpCatalogSnapshot(
  storage: CatalogStorage,
  catalog: EdgeMcpCatalog,
): Promise<string> {
  const revision = catalog.catalogMetadata.contractRevision;
  const declaredToolCount = catalog.catalogMetadata.toolCount;
  if (!isMcpContractRevision(revision) ||
      !Number.isSafeInteger(declaredToolCount) ||
      declaredToolCount !== catalog.manifest.length) {
    throw new Error("Invalid MCP catalog snapshot metadata.");
  }

  const chunks: EdgeMcpToolDescriptor[][] = [];
  for (let index = 0; index < catalog.manifest.length; index += CATALOG_CHUNK_SIZE) {
    const chunk = catalog.manifest.slice(index, index + CATALOG_CHUNK_SIZE)
      .map((tool) => structuredClone(tool));
    const size = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
    if (size > MAX_CATALOG_CHUNK_BYTES) {
      throw new Error(`MCP catalog chunk exceeds ${MAX_CATALOG_CHUNK_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }

  for (let index = 0; index < chunks.length; index += 1) {
    await storage.put(chunkKey(revision, index), chunks[index]);
  }

  const header: StoredCatalogHeaderV1 = {
    version: 1,
    contractRevision: revision,
    chunkCount: chunks.length,
    toolCount: catalog.manifest.length,
    catalogMetadata: structuredClone(catalog.catalogMetadata) as Record<string, unknown>,
    serverIdentity: structuredClone(catalog.serverIdentity),
  };
  await storage.put(headerKey(revision), header);
  return revision;
}

export async function readMcpCatalogSnapshot(
  storage: CatalogStorage,
  revision: string,
): Promise<EdgeMcpCatalog | null> {
  if (!isMcpContractRevision(revision)) return null;
  const header = await storage.get<StoredCatalogHeaderV1>(headerKey(revision));
  if (!isStoredCatalogHeader(header, revision)) return null;

  const chunks = await Promise.all(
    Array.from({ length: header.chunkCount }, (_, index) =>
      storage.get<unknown>(chunkKey(revision, index))),
  );
  if (chunks.some((chunk) => !Array.isArray(chunk))) return null;

  const manifest = chunks.flatMap((chunk) => chunk as EdgeMcpToolDescriptor[]);
  if (manifest.length !== header.toolCount) return null;

  return {
    manifest,
    catalogMetadata: header.catalogMetadata,
    serverIdentity: header.serverIdentity,
  };
}

function headerKey(revision: string): string {
  return `${ACTIVE_CATALOG_PREFIX}:${revision}:header`;
}

function chunkKey(revision: string, index: number): string {
  return `${ACTIVE_CATALOG_PREFIX}:${revision}:chunk:${index}`;
}

function isStoredCatalogHeader(
  value: unknown,
  revision: string,
): value is StoredCatalogHeaderV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const header = value as Partial<StoredCatalogHeaderV1>;
  return header.version === 1 &&
    header.contractRevision === revision &&
    Number.isSafeInteger(header.chunkCount) &&
    (header.chunkCount ?? 0) >= 0 &&
    Number.isSafeInteger(header.toolCount) &&
    (header.toolCount ?? -1) >= 0 &&
    typeof header.catalogMetadata === "object" &&
    header.catalogMetadata !== null &&
    !Array.isArray(header.catalogMetadata) &&
    header.catalogMetadata.contractRevision === revision &&
    header.catalogMetadata.toolCount === header.toolCount &&
    typeof header.serverIdentity === "object" &&
    header.serverIdentity !== null &&
    typeof header.serverIdentity.name === "string" &&
    typeof header.serverIdentity.version === "string";
}
