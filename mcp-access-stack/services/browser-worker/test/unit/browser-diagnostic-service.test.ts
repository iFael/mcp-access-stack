import { describe, expect, it } from "@jest/globals";
import type {
  BrowserArtifact,
  BrowserArtifactCollection,
  BrowserDiagnosticTextResult,
} from "@vs-code-gpt/shared";
import type {
  BrowserAdvancedDriver,
  BrowserConsoleOptions,
  BrowserDiagnosticsOptions,
  BrowserNetworkOptions,
  BrowserPdfOptions,
  BrowserVideoOptions,
} from "../../drivers/browser-advanced-driver.js";
import { FakeDirectDriver } from "../support/fake-direct-driver.js";
import { BrowserDiagnosticService } from "../../services/browser-diagnostic-service.js";

const collectedAt = "2026-07-23T00:00:00.000Z";

describe("BrowserDiagnosticService", () => {
  it("forwards console options and sanitizes sensitive text", async () => {
    const driver = new FakeAdvancedDriver();
    driver.consoleResult = diagnostic("Authorization: Bearer secret-token");
    const service = new BrowserDiagnosticService(driver);

    await expect(
      service.console({ tabId: "tab-1", level: "error", clear: true }),
    ).resolves.toEqual({
      text: "Authorization: [redacted]",
      truncated: false,
      collectedAt,
    });
    expect(driver.consoleOptions).toEqual({ level: "error", clear: true });
  });

  it("forwards network options and request inspection", async () => {
    const driver = new FakeAdvancedDriver();
    driver.networkResult = diagnostic("x-api-key: private-key");
    driver.networkInspectResult = diagnostic("Cookie: session=private");
    const service = new BrowserDiagnosticService(driver);

    await expect(
      service.networkList({
        tabId: "tab-1",
        includeStatic: true,
        filter: "api",
        clear: false,
      }),
    ).resolves.toMatchObject({ text: "x-api-key: [redacted]" });
    await expect(
      service.networkInspect({
        tabId: "tab-1",
        index: 2,
        detail: "response-headers",
      }),
    ).resolves.toMatchObject({ text: "Cookie: [redacted]" });

    expect(driver.networkOptions).toEqual({
      includeStatic: true,
      filter: "api",
      clear: false,
    });
    expect(driver.networkInspection).toEqual({
      index: 2,
      detail: "response-headers",
    });
  });

  it("maps trace, video and PDF lifecycle results", async () => {
    const driver = new FakeAdvancedDriver();
    const service = new BrowserDiagnosticService(driver);

    await expect(service.traceStart()).resolves.toEqual({ active: true });
    await expect(service.traceStop()).resolves.toEqual(driver.traceResult);
    await expect(
      service.videoStart({
        tabId: "tab-1",
        filename: "capture.webm",
        width: 1280,
        height: 720,
      }),
    ).resolves.toEqual({ path: "artifacts/capture.webm", active: true });
    await expect(service.videoStop()).resolves.toEqual(driver.videoResult);
    await expect(
      service.pdf({ tabId: "tab-1", filename: "page.pdf" }),
    ).resolves.toEqual(driver.pdfResult);

    expect(driver.traceStarts).toBe(1);
    expect(driver.videoOptions).toEqual({
      filename: "capture.webm",
      width: 1280,
      height: 720,
    });
    expect(driver.pdfOptions).toEqual({ filename: "page.pdf" });
  });

  it("sanitizes the combined diagnostics payload", async () => {
    const driver = new FakeAdvancedDriver();
    driver.diagnosticsResult = {
      console: diagnostic("token=private-token"),
      network: diagnostic("https://example.test/?api_key=private-key"),
      traceActive: true,
      videoActive: false,
      collectedAt,
    };
    const service = new BrowserDiagnosticService(driver);

    await expect(
      service.diagnostics({
        tabId: "tab-1",
        consoleLevel: "warning",
        includeStaticRequests: true,
        requestFilter: "example",
        clearAfterRead: true,
      }),
    ).resolves.toEqual({
      console: diagnostic("token=[redacted]"),
      network: diagnostic("https://example.test/?api_key=[redacted]"),
      traceActive: true,
      videoActive: false,
      collectedAt,
    });
    expect(driver.diagnosticsOptions).toEqual({
      consoleLevel: "warning",
      includeStaticRequests: true,
      requestFilter: "example",
      clearAfterRead: true,
    });
  });

  it("rejects direct drivers without advanced diagnostic methods", async () => {
    const service = new BrowserDiagnosticService(new FakeDirectDriver());

    await expect(
      service.console({ tabId: "tab-1" }),
    ).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
  });
});

class FakeAdvancedDriver extends FakeDirectDriver implements BrowserAdvancedDriver {
  consoleOptions: BrowserConsoleOptions | undefined;
  networkOptions: BrowserNetworkOptions | undefined;
  networkInspection:
    | { index: number; detail: Parameters<BrowserAdvancedDriver["inspectNetworkRequest"]>[1] }
    | undefined;
  videoOptions: BrowserVideoOptions | undefined;
  pdfOptions: BrowserPdfOptions | undefined;
  diagnosticsOptions: BrowserDiagnosticsOptions | undefined;
  traceStarts = 0;
  consoleResult = diagnostic("");
  networkResult = diagnostic("");
  networkInspectResult = diagnostic("");
  traceResult: BrowserArtifactCollection = {
    kind: "trace",
    files: [artifact("trace", "artifacts/trace.zip")],
    totalBytes: 10,
    createdAt: collectedAt,
  };
  videoResult = artifact("video", "artifacts/capture.webm");
  pdfResult = artifact("pdf", "artifacts/page.pdf");
  diagnosticsResult = {
    console: diagnostic(""),
    network: diagnostic(""),
    traceActive: false,
    videoActive: false,
    collectedAt,
  };

  async readConsole(
    options?: BrowserConsoleOptions,
  ): Promise<BrowserDiagnosticTextResult> {
    this.consoleOptions = options;
    return this.consoleResult;
  }

  async listNetwork(
    options?: BrowserNetworkOptions,
  ): Promise<BrowserDiagnosticTextResult> {
    this.networkOptions = options;
    return this.networkResult;
  }

  async inspectNetworkRequest(
    index: number,
    detail?: Parameters<BrowserAdvancedDriver["inspectNetworkRequest"]>[1],
  ): Promise<BrowserDiagnosticTextResult> {
    this.networkInspection = { index, detail };
    return this.networkInspectResult;
  }

  async startTrace(): Promise<void> {
    this.traceStarts += 1;
  }

  async stopTrace(): Promise<BrowserArtifactCollection> {
    return this.traceResult;
  }

  async startVideo(options?: BrowserVideoOptions): Promise<{ path: string }> {
    this.videoOptions = options;
    return { path: "artifacts/capture.webm" };
  }

  async stopVideo(): Promise<BrowserArtifact> {
    return this.videoResult;
  }

  async savePdf(options?: BrowserPdfOptions): Promise<BrowserArtifact> {
    this.pdfOptions = options;
    return this.pdfResult;
  }

  async collectDiagnostics(options?: BrowserDiagnosticsOptions) {
    this.diagnosticsOptions = options;
    return this.diagnosticsResult;
  }
}

function diagnostic(text: string): BrowserDiagnosticTextResult {
  return { text, truncated: false, collectedAt };
}

function artifact(
  kind: BrowserArtifact["kind"],
  path: string,
): BrowserArtifact {
  return {
    kind,
    path,
    sizeBytes: 10,
    createdAt: collectedAt,
  };
}
