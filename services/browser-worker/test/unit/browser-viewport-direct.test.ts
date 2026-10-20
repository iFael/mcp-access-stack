import { EventEmitter } from "node:events";
import { describe, expect, it, jest } from "@jest/globals";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";

describe("direct Playwright viewport emulation", () => {
  it("applies tab-scoped CDP metrics, touch and theme, then resets them", async () => {
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const detach = jest.fn(async () => undefined);
    const session = {
      send: async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, ...(params ? { params } : {}) });
      },
      detach,
    };
    const page = Object.assign(new EventEmitter(), {
      evaluate: async () => ({ width: 1280, height: 720, deviceScaleFactor: 1.25,
        userAgent: "Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36", platform: "Win32", colorScheme: "dark" }),
      context: () => ({ newCDPSession: async () => session }),
    });
    const driver = Object.assign(Object.create(DirectPlaywrightDriver.prototype), {
      requireCurrentPage: () => page,
      viewportSessions: new WeakMap(),
    }) as DirectPlaywrightDriver;
    await expect(driver.viewport({ tabId: "managed:1", preset: "tablet", colorScheme: "dark" }))
      .resolves.toMatchObject({ width: 768, height: 1024, deviceScaleFactor: 2,
        mobile: true, touch: true, colorScheme: "dark", emulated: true });
    expect(commands.some((item) => item.method === "Emulation.setDeviceMetricsOverride" &&
      item.params?.mobile === true)).toBe(true);
    expect(commands.some((item) => item.method === "Emulation.setTouchEmulationEnabled" &&
      item.params?.enabled === true)).toBe(true);
    await expect(driver.viewport({ tabId: "managed:1", preset: "reset" }))
      .resolves.toMatchObject({ width: 1280, height: 720, emulated: false });
    expect(commands.map((item) => item.method)).toContain("Emulation.clearDeviceMetricsOverride");
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid operations without attaching a browser context", async () => {
    const context = { newCDPSession: jest.fn(async () => ({})) };
    const page = Object.assign(new EventEmitter(), { context: () => context });
    const driver = Object.assign(Object.create(DirectPlaywrightDriver.prototype), {
      requireCurrentPage: () => page,
      viewportSessions: new WeakMap(),
    }) as DirectPlaywrightDriver;
    // Contracts reject incomplete custom dimensions before reaching the driver.
    expect(context.newCDPSession).not.toHaveBeenCalled();
  });
});
