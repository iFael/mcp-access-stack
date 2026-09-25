import { describe, expect, it } from "@jest/globals";
import {
  windowsExecutionNodeStateSchema,
  windowsExecutionReleaseManifestSchema,
} from "../src/index.js";

const sha256 = "a".repeat(64);
const now = "2026-08-16T00:00:00.000Z";
const CURRENT_SERVICES = ["edge-runtime", "browser-worker"] as const;

function createBundledNodeManifest() {
  return {
    version: 2 as const,
    releaseId: "1.2.0",
    commit: "b".repeat(40),
    platform: "win32-x64" as const,
    createdAt: now,
    runtimeMode: "bundled-node" as const,
    integrityRoot: "signed-distribution-manifest" as const,
    services: [
      { id: "edge-runtime" as const, entryArtifactId: "edge-host" },
      { id: "browser-worker" as const, entryArtifactId: "node-host-launcher" },
    ],
    artifacts: [
      {
        id: "edge-host",
        owner: "edge-runtime" as const,
        path: "native/McpEdgeHost.exe",
        sha256,
        sizeBytes: 50,
        authenticodeRequired: true,
      },
      {
        id: "edge-connector",
        owner: "edge-runtime" as const,
        path: "node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js",
        sha256,
        sizeBytes: 30,
        authenticodeRequired: false,
      },
      {
        id: "edge-validation-launcher",
        owner: "edge-runtime" as const,
        path: "deploy/windows/Start-McpEdgeConnector.ps1",
        sha256,
        sizeBytes: 40,
        authenticodeRequired: true,
      },
      {
        id: "browser-worker-server",
        owner: "browser-worker" as const,
        path: "services/browser-worker/dist/server.js",
        sha256,
        sizeBytes: 20,
        authenticodeRequired: false,
      },
      {
        id: "node-host-launcher",
        owner: "shared" as const,
        path: "compat/McpNodeHostLauncher.exe",
        sha256,
        sizeBytes: 60,
        authenticodeRequired: true,
      },
      {
        id: "browser-credential-broker",
        owner: "browser-worker" as const,
        path: "compat/McpCredentialBroker.exe",
        sha256,
        sizeBytes: 65,
        authenticodeRequired: true,
      },
      {
        id: "node-runtime",
        owner: "shared" as const,
        path: "runtime/node/node.exe",
        sha256,
        sizeBytes: 70,
        authenticodeRequired: false,
      },
    ],
  };
}

describe("Windows Edge execution contracts", () => {
  it("models exactly the two logical runtime services", () => {
    const parsed = windowsExecutionReleaseManifestSchema.parse(createBundledNodeManifest());
    expect(parsed.services.map((service) => service.id).sort()).toEqual(
      [...CURRENT_SERVICES].sort(),
    );
  });

  it("accepts additional valid artifacts without changing the service contract", () => {
    const manifest = createBundledNodeManifest();
    const initialArtifactCount = manifest.artifacts.length;
    manifest.artifacts.push({
      id: "edge-runtime-metadata",
      owner: "edge-runtime",
      path: "metadata/edge-runtime.json",
      sha256,
      sizeBytes: 5,
      authenticodeRequired: false,
    });

    expect(windowsExecutionReleaseManifestSchema.parse(manifest).artifacts).toHaveLength(initialArtifactCount + 1);
  });

  it("requires every service entry artifact to exist, be service-owned or shared, and be signed", () => {
    const missing = createBundledNodeManifest();
    missing.services[0]!.entryArtifactId = "missing-entry";
    expect(() => windowsExecutionReleaseManifestSchema.parse(missing)).toThrow(/entry artifact/u);

    const wrongOwner = createBundledNodeManifest();
    wrongOwner.artifacts[0]!.owner = "browser-worker";
    expect(() => windowsExecutionReleaseManifestSchema.parse(wrongOwner)).toThrow(/owned by edge-runtime or shared/u);

    const unsigned = createBundledNodeManifest();
    unsigned.artifacts[0]!.authenticodeRequired = false;
    expect(() => windowsExecutionReleaseManifestSchema.parse(unsigned)).toThrow(/entry artifact.*Authenticode/u);
  });

  it("requires one shared bundled Node runtime artifact", () => {
    const missing = createBundledNodeManifest();
    missing.artifacts = missing.artifacts.filter((artifact) => artifact.id !== "node-runtime");
    expect(() => windowsExecutionReleaseManifestSchema.parse(missing)).toThrow(/node-runtime/u);

    const wrongOwner = createBundledNodeManifest();
    wrongOwner.artifacts.find((artifact) => artifact.id === "node-runtime")!.owner = "edge-runtime";
    expect(() => windowsExecutionReleaseManifestSchema.parse(wrongOwner)).toThrow(/node-runtime.*shared/u);
  });

  it("rejects duplicate service and artifact identities", () => {
    const duplicateService = createBundledNodeManifest();
    duplicateService.services[1] = { ...duplicateService.services[0]! };
    expect(() => windowsExecutionReleaseManifestSchema.parse(duplicateService)).toThrow(/service/u);

    const duplicateArtifact = createBundledNodeManifest();
    duplicateArtifact.artifacts[1]!.id = duplicateArtifact.artifacts[0]!.id;
    expect(() => windowsExecutionReleaseManifestSchema.parse(duplicateArtifact)).toThrow(/artifact id/u);
  });

  it("rejects speculative runtime modes", () => {
    const manifest = createBundledNodeManifest();
    (manifest as { runtimeMode: string }).runtimeMode = "self-contained";
    expect(() => windowsExecutionReleaseManifestSchema.parse(manifest)).toThrow();
  });

  it("rejects path traversal and absolute artifact paths", () => {
    const traversal = createBundledNodeManifest();
    traversal.artifacts[0]!.path = "../host.exe";
    expect(() => windowsExecutionReleaseManifestSchema.parse(traversal)).toThrow();

    const absolute = createBundledNodeManifest();
    absolute.artifacts[0]!.path = "C:\\host.exe";
    expect(() => windowsExecutionReleaseManifestSchema.parse(absolute)).toThrow();
  });

  it("accepts offset-aware lifecycle timestamps written by the Windows producer", () => {
    const parsed = windowsExecutionNodeStateSchema.parse({
      version: 1,
      active: {
        releaseId: "1.1.0-beta.50",
        manifestSha256: sha256,
        materializedAt: "2026-09-21T13:41:30.2390389-03:00",
      },
      candidate: null,
      previous: {
        releaseId: "1.1.0-beta.48",
        manifestSha256: "b".repeat(64),
        materializedAt: "2026-09-20T23:26:37.0529727-03:00",
      },
      updatedAt: "2026-09-21T16:45:41.6812804+00:00",
    });

    expect(parsed.active?.releaseId).toBe("1.1.0-beta.50");
    expect(parsed.previous?.releaseId).toBe("1.1.0-beta.48");
  });

  it("keeps active, candidate and previous release pointers distinct", () => {
    const pointer = {
      releaseId: "1.2.0",
      manifestSha256: sha256,
      materializedAt: now,
    };

    expect(
      windowsExecutionNodeStateSchema.parse({
        version: 1,
        active: pointer,
        candidate: { ...pointer, releaseId: "1.2.1" },
        previous: { ...pointer, releaseId: "1.1.0" },
        updatedAt: now,
      }),
    ).toMatchObject({
      version: 1,
      active: { releaseId: "1.2.0" },
      candidate: { releaseId: "1.2.1" },
      previous: { releaseId: "1.1.0" },
    });

    expect(() =>
      windowsExecutionNodeStateSchema.parse({
        version: 1,
        active: pointer,
        candidate: pointer,
        previous: null,
        updatedAt: now,
      }),
    ).toThrow(/candidate must differ from the active release/u);
  });
});
