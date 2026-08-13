import { describe, expect, it } from "@jest/globals";
import type { BrowserDriver } from "../../drivers/browser-driver.js";
import {
  assertBrowserOperationAllowed,
  isBrowserAdvancedOperation,
} from "../../policies/browser-operation-policy.js";

const advancedDriver = {
  kind: "direct",
  readConsole() {},
  listNetwork() {},
  inspectNetworkRequest() {},
  startTrace() {},
  stopTrace() {},
  startVideo() {},
  stopVideo() {},
  savePdf() {},
  collectDiagnostics() {},
} as unknown as BrowserDriver;

const basicDriver = {
  kind: "direct",
} as unknown as BrowserDriver;

describe("browser operation policy", () => {
  it("classifies only diagnostic operations as advanced", () => {
    expect(isBrowserAdvancedOperation("console")).toBe(true);
    expect(isBrowserAdvancedOperation("networkInspect")).toBe(true);
    expect(isBrowserAdvancedOperation("navigate")).toBe(false);
  });

  it("allows advanced operations only in diagnostic mode", () => {
    expect(() =>
      assertBrowserOperationAllowed("console", "diagnostic", advancedDriver),
    ).not.toThrow();
    expect(() =>
      assertBrowserOperationAllowed("navigate", "efficient", basicDriver),
    ).not.toThrow();
    expect(() =>
      assertBrowserOperationAllowed("console", "efficient", advancedDriver),
    ).toThrow(expect.objectContaining({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    }));
  });

  it("reports a capability error when the direct engine lacks diagnostics", () => {
    expect(() =>
      assertBrowserOperationAllowed("console", "diagnostic", basicDriver),
    ).toThrow(expect.objectContaining({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    }));
  });
});
