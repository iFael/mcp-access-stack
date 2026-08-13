import type {
  BrowserConsoleInput,
  BrowserConsoleResult,
  BrowserDiagnosticsInput,
  BrowserDiagnosticsResult,
  BrowserNetworkInspectInput,
  BrowserNetworkListInput,
  BrowserNetworkResult,
  BrowserPdfInput,
  BrowserPdfResult,
  BrowserTraceStartResult,
  BrowserTraceStopResult,
  BrowserVideoStartInput,
  BrowserVideoStartResult,
  BrowserVideoStopResult,
} from "@vs-code-gpt/shared";
import {
  requireBrowserAdvancedDriver,
  sanitizeBrowserDiagnosticResult,
} from "../drivers/browser-advanced-driver.js";
import type { BrowserDriver } from "../drivers/browser-driver.js";

type ConsoleResult = Omit<BrowserConsoleResult, "tabId">;
type NetworkResult = Omit<BrowserNetworkResult, "tabId">;
type TraceStartResult = Omit<BrowserTraceStartResult, "tabId">;
type TraceStopResult = Omit<BrowserTraceStopResult, "tabId">;
type VideoStartResult = Omit<BrowserVideoStartResult, "tabId">;
type VideoStopResult = Omit<BrowserVideoStopResult, "tabId">;
type PdfResult = Omit<BrowserPdfResult, "tabId">;
type DiagnosticsResult = Omit<BrowserDiagnosticsResult, "tabId">;

export class BrowserDiagnosticService {
  constructor(private readonly driver: BrowserDriver) {}

  async console(input: BrowserConsoleInput): Promise<ConsoleResult> {
    const result = await this.advancedDriver().readConsole({
      ...(input.level === undefined ? {} : { level: input.level }),
      ...(input.clear === undefined ? {} : { clear: input.clear }),
    });
    return sanitizeBrowserDiagnosticResult(result);
  }

  async networkList(input: BrowserNetworkListInput): Promise<NetworkResult> {
    const result = await this.advancedDriver().listNetwork({
      ...(input.includeStatic === undefined
        ? {}
        : { includeStatic: input.includeStatic }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.clear === undefined ? {} : { clear: input.clear }),
    });
    return sanitizeBrowserDiagnosticResult(result);
  }

  async networkInspect(
    input: BrowserNetworkInspectInput,
  ): Promise<NetworkResult> {
    const result = await this.advancedDriver().inspectNetworkRequest(
      input.index,
      input.detail,
    );
    return sanitizeBrowserDiagnosticResult(result);
  }

  async traceStart(): Promise<TraceStartResult> {
    await this.advancedDriver().startTrace();
    return { active: true };
  }

  async traceStop(): Promise<TraceStopResult> {
    const result = await this.advancedDriver().stopTrace();
    return { ...result, kind: "trace" };
  }

  async videoStart(input: BrowserVideoStartInput): Promise<VideoStartResult> {
    const result = await this.advancedDriver().startVideo({
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
    });
    return { path: result.path, active: true };
  }

  async videoStop(): Promise<VideoStopResult> {
    const result = await this.advancedDriver().stopVideo();
    return { ...result, kind: "video" };
  }

  async pdf(input: BrowserPdfInput): Promise<PdfResult> {
    const result = await this.advancedDriver().savePdf({
      ...(input.filename === undefined ? {} : { filename: input.filename }),
    });
    return { ...result, kind: "pdf" };
  }

  async diagnostics(input: BrowserDiagnosticsInput): Promise<DiagnosticsResult> {
    const result = await this.advancedDriver().collectDiagnostics({
      ...(input.consoleLevel === undefined
        ? {}
        : { consoleLevel: input.consoleLevel }),
      ...(input.includeStaticRequests === undefined
        ? {}
        : { includeStaticRequests: input.includeStaticRequests }),
      ...(input.requestFilter === undefined
        ? {}
        : { requestFilter: input.requestFilter }),
      ...(input.clearAfterRead === undefined
        ? {}
        : { clearAfterRead: input.clearAfterRead }),
    });
    return {
      ...result,
      console: sanitizeBrowserDiagnosticResult(result.console),
      network: sanitizeBrowserDiagnosticResult(result.network),
    };
  }

  private advancedDriver() {
    return requireBrowserAdvancedDriver(this.driver);
  }
}
