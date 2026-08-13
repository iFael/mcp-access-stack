import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_BROWSER_OPERATION_MODE,
  resolveBrowserOperationMode,
} from "../../policies/browser-operation-mode.js";

describe("BrowserOperationMode", () => {
  it("keeps interactive as the safe direct-engine default", () => {
    expect(DEFAULT_BROWSER_OPERATION_MODE).toBe("interactive");
    expect(resolveBrowserOperationMode()).toEqual({
      mode: "interactive",
      routingStrategy: "direct",
      profileType: "persistent",
      observability: "standard",
      retainDiagnosticArtifacts: false,
      allowAdvancedOperations: false,
      allowAutomaticFallback: false,
    });
  });

  it("keeps efficient mode on the same persistent direct engine", () => {
    expect(resolveBrowserOperationMode("efficient")).toEqual({
      mode: "efficient",
      routingStrategy: "direct",
      profileType: "persistent",
      observability: "standard",
      retainDiagnosticArtifacts: false,
      allowAdvancedOperations: false,
      allowAutomaticFallback: false,
    });
  });

  it("enables diagnostic observability without changing engines", () => {
    expect(resolveBrowserOperationMode("diagnostic")).toEqual({
      mode: "diagnostic",
      routingStrategy: "direct",
      profileType: "persistent",
      observability: "diagnostic",
      retainDiagnosticArtifacts: true,
      allowAdvancedOperations: true,
      allowAutomaticFallback: false,
    });
  });

  it("keeps auto mode direct and policy-free", () => {
    expect(resolveBrowserOperationMode("auto")).toEqual({
      mode: "auto",
      routingStrategy: "direct",
      profileType: "persistent",
      observability: "standard",
      retainDiagnosticArtifacts: false,
      allowAdvancedOperations: false,
      allowAutomaticFallback: false,
    });
  });
});
