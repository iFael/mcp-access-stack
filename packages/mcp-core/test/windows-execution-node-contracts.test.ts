import { describe, expect, it } from "@jest/globals";
import {
  windowsExecutionNodeStateSchema,
  windowsExecutionReleaseManifestSchema,
} from "../src/index.js";

const sha256 = "a".repeat(64);
const now = "2026-08-16T00:00:00.000Z";

function createBundledNodeManifest() {
  return {
    version: 1 as const,
    releaseId: "1.2.0",
    commit: "b".repeat(40),
    platform: "win32-x64" as const,
    createdAt: now,
    runtimeMode: "bundled-node" as const,
    integrityRoot: "signed-distribution-manifest" as const,
    artifacts: [
      {
        role: "mcp-host" as const,
        path: "native/McpHost.exe",
        sha256,
        sizeBytes: 10,
        authenticodeRequired: true,
      },
      {
        role: "workspace-agent" as const,
        path: "services/workspace-agent/dist/cli.js",
        sha256,
        sizeBytes: 20,
        authenticodeRequired: false,
      },
      {
        role: "browser-worker" as const,
        path: "services/browser-worker/dist/server.js",
        sha256,
        sizeBytes: 30,
        authenticodeRequired: false,
      },
      {
        role: "node-runtime" as const,
        path: "runtime/node/node.exe",
        sha256,
        sizeBytes: 40,
        authenticodeRequired: false,
      },
    ],
  };
}

describe("minimal Windows execution node contracts", () => {
  it("accepts the transitional bundled-node release layout", () => {
    expect(windowsExecutionReleaseManifestSchema.parse(createBundledNodeManifest())).toMatchObject({
      releaseId: "1.2.0",
      runtimeMode: "bundled-node",
    });
  });

  it("accepts a future self-contained layout without a Node runtime", () => {
    const manifest = createBundledNodeManifest();
    manifest.runtimeMode = "self-contained" as never;
    manifest.artifacts = manifest.artifacts.filter(
      (artifact) => artifact.role !== "node-runtime",
    );

    expect(windowsExecutionReleaseManifestSchema.parse(manifest)).toMatchObject({
      runtimeMode: "self-contained",
    });
  });

  it("rejects path traversal and absolute artifact paths", () => {
    const traversal = createBundledNodeManifest();
    traversal.artifacts[0]!.path = "../McpHost.exe";
    expect(() => windowsExecutionReleaseManifestSchema.parse(traversal)).toThrow();

    const absolute = createBundledNodeManifest();
    absolute.artifacts[0]!.path = "C:\\McpHost.exe";
    expect(() => windowsExecutionReleaseManifestSchema.parse(absolute)).toThrow();
  });

  it("requires Authenticode for McpHost while allowing manifest-bound JS payloads", () => {
    const manifest = createBundledNodeManifest();
    expect(windowsExecutionReleaseManifestSchema.parse(manifest)).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "workspace-agent", authenticodeRequired: false }),
        expect.objectContaining({ role: "browser-worker", authenticodeRequired: false }),
      ]),
    });

    manifest.artifacts[0]!.authenticodeRequired = false;
    expect(() => windowsExecutionReleaseManifestSchema.parse(manifest)).toThrow(
      /mcp-host must require Authenticode validation/u,
    );
  });

  it("rejects duplicate roles and missing runtime evidence", () => {
    const duplicate = createBundledNodeManifest();
    duplicate.artifacts[3] = {
      ...duplicate.artifacts[0]!,
      path: "native/duplicate.exe",
    };
    expect(() => windowsExecutionReleaseManifestSchema.parse(duplicate)).toThrow(
      /duplicate artifact role/u,
    );

    const missingNode = createBundledNodeManifest();
    missingNode.artifacts = missingNode.artifacts.filter(
      (artifact) => artifact.role !== "node-runtime",
    );
    expect(() => windowsExecutionReleaseManifestSchema.parse(missingNode)).toThrow(
      /bundled-node releases must include a node-runtime artifact/u,
    );
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
        candidate: {
          ...pointer,
          releaseId: "1.2.1",
        },
        previous: {
          ...pointer,
          releaseId: "1.1.0",
        },
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
