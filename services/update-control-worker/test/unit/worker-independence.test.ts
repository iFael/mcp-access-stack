import { readFile } from "node:fs/promises";
import { describe, expect, it, jest } from "@jest/globals";
import { fileURLToPath } from "node:url";
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

  it("deploys as a separate Worker with no Edge service binding or shared workflow storage", async () => {
    const configPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      name: string;
      workers_dev: boolean;
      preview_urls: boolean;
      durable_objects: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
      services?: unknown;
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
      vars?: Record<string, string>;
    };

    expect(config.name).toBe("mcp-v3-update-control");
    expect(config.name).not.toBe("mcp-access-stack");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.services).toBeUndefined();
    expect(config.durable_objects.bindings).toEqual([
      { name: "UPDATE_CONTROL_AUTH_STATE", class_name: "UpdateControlAuthState" },
    ]);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["UpdateControlAuthState"] },
    ]);
    expect(config.vars).toBeUndefined();
    expect(await readFile(configPath, "utf8")).not.toContain(".workers.dev");
  });
});
