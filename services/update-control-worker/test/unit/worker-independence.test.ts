import { readFile } from "node:fs/promises";
import { describe, expect, it, jest } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { ORACLE_CHANNEL_CONNECT_PATH, ORACLE_CHANNEL_ORIGIN, ORACLE_CHANNEL_SCOPE } from "../../src/oracle-channel.js";
import updateControlWorker, { type UpdateControlWorkerEnv } from "../../src/worker.js";

describe("Update Control Worker independent deployment", () => {
  it("routes MCP traffic only to its own authorization/session DO", async () => {
    const doResponse = new Response("independent-worker", { status: 200 });
    const doFetch = jest.fn(async () => doResponse);
    const requestedIds: string[] = [];
    const env = {
      UPDATE_CONTROL_AUTH_STATE: {
        idFromName: (name: string) => {
          requestedIds.push(name);
          return { id: name };
        },
        get: (id: { id: string }) => {
          requestedIds.push(id.id);
          return { fetch: doFetch };
        },
      },
    } as unknown as UpdateControlWorkerEnv;

    const response = await updateControlWorker.fetch(
      new Request("https://mcp-update-control.example.test/mcp", { method: "POST" }),
      env,
    );

    expect(await response.text()).toBe("independent-worker");
    expect(requestedIds).toEqual(["update-control-auth-v1", "update-control-auth-v1"]);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("routes only the fixed Oracle WSS path to the separate transport DO", async () => {
    const authFetch = jest.fn(async () => new Response("auth"));
    const channelFetch = jest.fn(async () => new Response("channel"));
    const authIds: string[] = [];
    const channelIds: string[] = [];
    const env = {
      UPDATE_CONTROL_AUTH_STATE: {
        idFromName: (name: string) => {
          authIds.push(name);
          return { id: name };
        },
        get: () => ({ fetch: authFetch }),
      },
      UPDATE_CONTROL_ORACLE_CHANNEL: {
        idFromName: (name: string) => {
          channelIds.push(name);
          return { id: name };
        },
        get: (id: { id: string }) => {
          channelIds.push(id.id);
          return { fetch: channelFetch };
        },
      },
    } as unknown as UpdateControlWorkerEnv;

    const handshake = await updateControlWorker.fetch(
      new Request("https://mcp-v3-update-control.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH, {
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: ORACLE_CHANNEL_ORIGIN,
          authorization: "Bearer test-oracle-channel-token",
        },
      }),
      env,
    );
    expect(await handshake.text()).toBe("channel");
    expect(channelIds).toEqual([ORACLE_CHANNEL_SCOPE, ORACLE_CHANNEL_SCOPE]);
    expect(authIds).toEqual([]);
    expect(authFetch).not.toHaveBeenCalled();

    const internalRpcPathIsNotRoutedPublicly = await updateControlWorker.fetch(
      new Request("https://mcp-v3-update-control.workers.dev/_internal/rpc", { method: "POST" }),
      env,
    );
    expect(await internalRpcPathIsNotRoutedPublicly.text()).toBe("auth");
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(channelFetch).toHaveBeenCalledTimes(1);
  });

  it("deploys as a separate Worker with no Edge service binding or shared workflow storage", async () => {
    const configPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      name: string;
      compatibility_date: string;
      workers_dev: boolean;
      preview_urls: boolean;
      durable_objects: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
      services?: unknown;
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
      vars?: Record<string, string>;
    };

    expect(config.name).toBe("mcp-v3-update-control");
    expect(config.name).not.toBe("mcp-access-stack");
    expect(config.compatibility_date).toBe("2026-08-17");
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.services).toBeUndefined();
    expect(config.durable_objects.bindings).toEqual([
      { name: "UPDATE_CONTROL_AUTH_STATE", class_name: "UpdateControlAuthState" },
      { name: "UPDATE_CONTROL_ORACLE_CHANNEL", class_name: "UpdateControlOracleChannel" },
    ]);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["UpdateControlAuthState"] },
      { tag: "v2", new_sqlite_classes: ["UpdateControlOracleChannel"] },
    ]);
    expect(config.vars).toBeUndefined();
    expect(await readFile(configPath, "utf8")).not.toContain(".workers.dev");
  });
});
