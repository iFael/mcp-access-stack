import type {
  BrowserActionResult,
  BrowserClickInput,
  BrowserCloseTabInput,
  BrowserConnectInput,
  BrowserConnectResult,
  BrowserConsoleInput,
  BrowserConsoleResult,
  BrowserDiagnosticsInput,
  BrowserDiagnosticsResult,
  BrowserDownloadInput,
  BrowserDownloadResult,
  BrowserUploadInput,
  BrowserUploadResult,
  BrowserExtractInput,
  BrowserExtractResult,
  BrowserFillInput,
  BrowserFinishTaskInput,
  BrowserFinishTaskResult,
  BrowserFrameClickInput,
  BrowserFrameExtractInput,
  BrowserFrameExtractResult,
  BrowserFrameFillInput,
  BrowserNavigateInput,
  BrowserNetworkInspectInput,
  BrowserNetworkListInput,
  BrowserNetworkResult,
  BrowserOpenInput,
  BrowserOpenAuthorizedSiteInput,
  BrowserOpenAuthorizedSiteResult,
  BrowserPdfInput,
  BrowserPdfResult,
  BrowserPressInput,
  BrowserScreenshotInput,
  BrowserScreenshotResult,
  BrowserSequenceInput,
  BrowserSequenceResult,
  BrowserSnapshotInput,
  BrowserSnapshotResult,
  BrowserStatusInput,
  BrowserStatusResult,
  BrowserTabActionInput,
  BrowserTraceInput,
  BrowserTraceStartResult,
  BrowserTraceStopResult,
  BrowserTabResult,
  BrowserTabsInput,
  BrowserTabsResult,
  BrowserVideoStartInput,
  BrowserVideoStartResult,
  BrowserVideoStopInput,
  BrowserVideoStopResult,
  BrowserWaitInput,
} from "./browser-contracts.js";
import type {
  BrowserDomIndexInput,
  BrowserDomIndexResult,
  BrowserFrameSequenceInput,
  BrowserFrameSequenceResult,
  BrowserNavigatePathInput,
  BrowserNavigatePathResult,
  BrowserProfilePageInput,
  BrowserProfilePageResult,
} from "./legacy-browser-contracts.js";
import type { OperationContext } from "./contracts.js";

/** Port between MCP browser tools and a local isolated browser worker. */
export interface BrowserExecutor {
  status(input: BrowserStatusInput, context?: OperationContext): Promise<BrowserStatusResult>;
  connect(input: BrowserConnectInput, context?: OperationContext): Promise<BrowserConnectResult>;
  tabs(input: BrowserTabsInput, context?: OperationContext): Promise<BrowserTabsResult>;
  open(input: BrowserOpenInput, context?: OperationContext): Promise<BrowserTabResult>;
  openAuthorizedSite(
    input: BrowserOpenAuthorizedSiteInput,
    context?: OperationContext,
  ): Promise<BrowserOpenAuthorizedSiteResult>;
  navigate(input: BrowserNavigateInput, context?: OperationContext): Promise<BrowserTabResult>;
  snapshot(input: BrowserSnapshotInput, context?: OperationContext): Promise<BrowserSnapshotResult>;
  click(input: BrowserClickInput, context?: OperationContext): Promise<BrowserActionResult>;
  fill(input: BrowserFillInput, context?: OperationContext): Promise<BrowserActionResult>;
  press(input: BrowserPressInput, context?: OperationContext): Promise<BrowserActionResult>;
  wait(input: BrowserWaitInput, context?: OperationContext): Promise<BrowserActionResult>;
  extract(input: BrowserExtractInput, context?: OperationContext): Promise<BrowserExtractResult>;
  sequence(input: BrowserSequenceInput, context?: OperationContext): Promise<BrowserSequenceResult>;
  frameExtract?(input: BrowserFrameExtractInput, context?: OperationContext): Promise<BrowserFrameExtractResult>;
  frameClick?(input: BrowserFrameClickInput, context?: OperationContext): Promise<BrowserActionResult>;
  frameFill?(input: BrowserFrameFillInput, context?: OperationContext): Promise<BrowserActionResult>;
  profilePage?(input: BrowserProfilePageInput, context?: OperationContext): Promise<BrowserProfilePageResult>;
  domIndex?(input: BrowserDomIndexInput, context?: OperationContext): Promise<BrowserDomIndexResult>;
  frameSequence?(input: BrowserFrameSequenceInput, context?: OperationContext): Promise<BrowserFrameSequenceResult>;
  navigatePath?(input: BrowserNavigatePathInput, context?: OperationContext): Promise<BrowserNavigatePathResult>;
  screenshot(input: BrowserScreenshotInput, context?: OperationContext): Promise<BrowserScreenshotResult>;
  goBack(input: BrowserTabActionInput, context?: OperationContext): Promise<BrowserTabResult>;
  goForward(input: BrowserTabActionInput, context?: OperationContext): Promise<BrowserTabResult>;
  closeTab(input: BrowserCloseTabInput, context?: OperationContext): Promise<BrowserActionResult>;
  finishTask(input: BrowserFinishTaskInput, context?: OperationContext): Promise<BrowserFinishTaskResult>;
  download(input: BrowserDownloadInput, context?: OperationContext): Promise<BrowserDownloadResult>;
  upload(input: BrowserUploadInput, context?: OperationContext): Promise<BrowserUploadResult>;
  console(input: BrowserConsoleInput, context?: OperationContext): Promise<BrowserConsoleResult>;
  networkList(input: BrowserNetworkListInput, context?: OperationContext): Promise<BrowserNetworkResult>;
  networkInspect(input: BrowserNetworkInspectInput, context?: OperationContext): Promise<BrowserNetworkResult>;
  traceStart(input: BrowserTraceInput, context?: OperationContext): Promise<BrowserTraceStartResult>;
  traceStop(input: BrowserTraceInput, context?: OperationContext): Promise<BrowserTraceStopResult>;
  videoStart(input: BrowserVideoStartInput, context?: OperationContext): Promise<BrowserVideoStartResult>;
  videoStop(input: BrowserVideoStopInput, context?: OperationContext): Promise<BrowserVideoStopResult>;
  pdf(input: BrowserPdfInput, context?: OperationContext): Promise<BrowserPdfResult>;
  diagnostics(input: BrowserDiagnosticsInput, context?: OperationContext): Promise<BrowserDiagnosticsResult>;
}
