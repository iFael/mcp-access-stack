import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { createOracleReleaseReadApi } from "../../src/read-api.js";
import { createOracleReadApiServer } from "../../src/node-read-server.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";

const TOKEN = "x".repeat(48);

describe("Oracle read API server boundary", () => {
  let root: string;
  let orchestrator: ReleaseOrchestrator;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-v3-read-server-"));
    const releaseRoot = path.join(root, "release-tree");
    mkdirSync(releaseRoot, { recursive: true });
    orchestrator = new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath: path.join(root, "state", "orchestrator.sqlite"),
      releaseRoot,
    }));
  });

  afterEach(() => {
    orchestrator.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the API on loopback and rejects a non-loopback bind", async () => {
    const handler = createOracleReleaseReadApi({ orchestrator, bearerToken: TOKEN });
    expect(() => createOracleReadApiServer({ handler, host: "0.0.0.0" })).toThrow(/loopback/u);

    const server = createOracleReadApiServer({ handler, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/runs`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ runs: [], nextCursor: null, hasMore: false });

      const bodyRequest = await fetch(`http://127.0.0.1:${address.port}/internal/v1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "x",
      });
      expect(bodyRequest.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});
