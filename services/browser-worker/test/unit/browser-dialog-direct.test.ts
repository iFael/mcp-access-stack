import { EventEmitter } from "node:events";
import { describe, expect, it, jest } from "@jest/globals";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";

describe("direct Playwright JavaScript dialog lifecycle", () => {
  it("observes a confirm dialog, rejects stale messages, and dismisses it explicitly", async () => {
    const page = new EventEmitter();
    const dismiss = jest.fn(async () => undefined);
    const accept = jest.fn(async (_text?: string) => undefined);
    const driver = Object.assign(Object.create(DirectPlaywrightDriver.prototype), {
      observedDialogs: new WeakMap(),
      requireCurrentPage: () => page,
    }) as DirectPlaywrightDriver;
    const tabId = "managed-tab";
    expect(await driver.dialog({ tabId, action: "arm" })).toMatchObject({ state: "armed" });
    page.emit("dialog", { type: () => "confirm", message: () => "Delete records?", dismiss, accept });
    expect(await driver.dialog({ tabId, action: "inspect" })).toMatchObject({
      state: "open", dialogType: "confirm", message: "Delete records?",
    });
    await expect(driver.dialog({ tabId, action: "respond", response: "accept",
      expectedMessage: "Changed message" })).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(accept).not.toHaveBeenCalled();
    expect(await driver.dialog({ tabId, action: "respond", response: "dismiss",
      expectedMessage: "Delete records?" })).toMatchObject({ state: "idle" });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(page.listenerCount("dialog")).toBe(0);
  });

  it("releases the observer on cancellation without acting on unrelated pages", async () => {
    const page = new EventEmitter();
    const driver = Object.assign(Object.create(DirectPlaywrightDriver.prototype), {
      observedDialogs: new WeakMap(),
      requireCurrentPage: () => page,
    }) as DirectPlaywrightDriver;
    await driver.dialog({ tabId: "managed-tab", action: "arm" });
    await expect(driver.dialog({ tabId: "managed-tab", action: "arm" }))
      .rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    expect(await driver.dialog({ tabId: "managed-tab", action: "cancel" })).toMatchObject({ state: "idle" });
    expect(page.listenerCount("dialog")).toBe(0);
  });
});
