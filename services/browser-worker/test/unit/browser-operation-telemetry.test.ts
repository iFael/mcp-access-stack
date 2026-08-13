import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { BrowserOperationTelemetry } from "../../infrastructure/browser-operation-telemetry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("BrowserOperationTelemetry", () => {
  it("correlates nested runtime events with an opaque trace and hashed resource refs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-telemetry-"));
    directories.push(directory);
    const telemetry = new BrowserOperationTelemetry(directory);
    const taskId = "task-private-value";
    const tabId = "tab-private-value";

    await telemetry.run(
      { traceId: "a".repeat(32), operation: "open" },
      async () => {
        telemetry.record({
          event: "browser_tab_selection",
          selection: "exact",
          cache: "hit",
          taskRef: telemetry.reference("task", taskId),
          tabRef: telemetry.reference("tab", tabId),
        });
      },
    );
    await telemetry.flush();

    const contents = await readFile(telemetry.filePath, "utf8");
    expect(contents).toContain(`"traceId":"${"a".repeat(32)}"`);
    expect(contents).toContain('"operation":"open"');
    expect(contents).toContain('"selection":"exact"');
    expect(contents).not.toContain(taskId);
    expect(contents).not.toContain(tabId);
  });
});
