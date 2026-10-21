import { describe, expect, it } from "@jest/globals";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";

function mockDriver(mime: string, body: string) {
  const page = {};
  const response = {
    headers: () => ({ "content-type": mime }),
    body: async () => Buffer.from(body, "utf8"),
  };
  const entry = { request: {}, response };
  const driver = Object.assign(Object.create(DirectPlaywrightDriver.prototype), {
    networkEntries: new Map([[page, [entry]]]),
    requireCurrentPage: () => page,
    normalizeDiagnostic: (value: unknown) => ({
      text: String(value), truncated: false, collectedAt: "2026-10-20T10:00:00.000Z",
    }),
  }) as DirectPlaywrightDriver;
  return driver;
}

describe("direct browser network response inspection", () => {
  it("returns textual response content instead of an unsupported placeholder", async () => {
    const driver = mockDriver("application/json; charset=utf-8", '{"ok":true}');
    await expect(driver.inspectNetworkRequest(1, "response-body"))
      .resolves.toMatchObject({ text: '{"ok":true}' });
  });

  it("does not present binary response contents as readable text", async () => {
    const driver = mockDriver("image/png", "binary image bytes");
    await expect(driver.inspectNetworkRequest(1, "response-body"))
      .resolves.toMatchObject({ text: "[binary response not available as text]" });
  });

  it("bounds textual response bodies at 256 KiB", async () => {
    const driver = mockDriver("text/plain", "x".repeat(300_000));
    const result = await driver.inspectNetworkRequest(1, "response-body");
    expect(result.text.length).toBeLessThanOrEqual(256 * 1024 + 20);
    expect(result.text).toContain("[truncated]");
  });
});
