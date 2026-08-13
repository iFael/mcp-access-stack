import * as c from "@vs-code-gpt/shared";
import type { BrowserExecutor } from "@vs-code-gpt/shared";

export class McpBrowserSmokeClient implements BrowserExecutor {
  constructor(
    private readonly baseUrl: URL,
    private readonly mcpPath: string,
    private readonly timeoutMs: number,
  ) {}

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const result = await this.request("tools/list", {});
    const tools = result.tools;
    if (!Array.isArray(tools)) throw new Error("MCP tools/list did not return tools.");
    return tools.map((tool, index) => asRecord(tool, `tools[${index}]`));
  }

  async status(input: c.BrowserStatusInput): Promise<c.BrowserStatusResult> {
    return c.browserStatusResultSchema.parse(
      await this.callTool("browser_status", c.browserStatusInputSchema.parse(input)),
    );
  }

  async connect(input: c.BrowserConnectInput): Promise<c.BrowserConnectResult> {
    return c.browserConnectResultSchema.parse(
      await this.callTool("browser_connect", c.browserConnectInputSchema.parse(input)),
    );
  }

  async tabs(input: c.BrowserTabsInput): Promise<c.BrowserTabsResult> {
    return c.browserTabsResultSchema.parse(
      await this.callTool("browser_tabs", c.browserTabsInputSchema.parse(input)),
    );
  }

  async open(input: c.BrowserOpenInput): Promise<c.BrowserTabResult> {
    return c.browserTabResultSchema.parse(
      await this.callTool("browser_open", c.browserOpenInputSchema.parse(input)),
    );
  }

  async openAuthorizedSite(
    input: c.BrowserOpenAuthorizedSiteInput,
  ): Promise<c.BrowserOpenAuthorizedSiteResult> {
    return c.browserOpenAuthorizedSiteResultSchema.parse(
      await this.callTool(
        "browser_open_authorized_site",
        c.browserOpenAuthorizedSiteInputSchema.parse(input),
      ),
    );
  }

  async navigate(input: c.BrowserNavigateInput): Promise<c.BrowserTabResult> {
    return c.browserTabResultSchema.parse(
      await this.callTool("browser_navigate", c.browserNavigateInputSchema.parse(input)),
    );
  }

  async snapshot(input: c.BrowserSnapshotInput): Promise<c.BrowserSnapshotResult> {
    return c.browserSnapshotResultSchema.parse(
      await this.callTool("browser_snapshot", c.browserSnapshotInputSchema.parse(input)),
    );
  }

  async click(input: c.BrowserClickInput): Promise<c.BrowserActionResult> {
    return c.browserActionResultSchema.parse(
      await this.callTool("browser_click", c.browserClickInputSchema.parse(input)),
    );
  }

  async fill(input: c.BrowserFillInput): Promise<c.BrowserActionResult> {
    return c.browserActionResultSchema.parse(
      await this.callTool("browser_fill", c.browserFillInputSchema.parse(input)),
    );
  }

  async press(input: c.BrowserPressInput): Promise<c.BrowserActionResult> {
    return c.browserActionResultSchema.parse(
      await this.callTool("browser_press", c.browserPressInputSchema.parse(input)),
    );
  }

  async wait(input: c.BrowserWaitInput): Promise<c.BrowserActionResult> {
    return c.browserActionResultSchema.parse(
      await this.callTool("browser_wait", c.browserWaitInputSchema.parse(input)),
    );
  }

  async extract(input: c.BrowserExtractInput): Promise<c.BrowserExtractResult> {
    return c.browserExtractResultSchema.parse(
      await this.callTool("browser_extract", c.browserExtractInputSchema.parse(input)),
    );
  }

  async sequence(
    input: c.BrowserSequenceInput,
  ): Promise<c.BrowserSequenceResult> {
    return c.browserSequenceResultSchema.parse(
      await this.callTool(
        "browser_sequence",
        c.browserSequenceInputSchema.parse(input),
      ),
    );
  }

  async screenshot(
    input: c.BrowserScreenshotInput,
  ): Promise<c.BrowserScreenshotResult> {
    return c.browserScreenshotResultSchema.parse(
      await this.callTool(
        "browser_screenshot",
        c.browserScreenshotInputSchema.parse(input),
      ),
    );
  }

  async goBack(input: c.BrowserTabActionInput): Promise<c.BrowserTabResult> {
    return c.browserTabResultSchema.parse(
      await this.callTool("browser_go_back", c.browserTabActionInputSchema.parse(input)),
    );
  }

  async goForward(input: c.BrowserTabActionInput): Promise<c.BrowserTabResult> {
    return c.browserTabResultSchema.parse(
      await this.callTool(
        "browser_go_forward",
        c.browserTabActionInputSchema.parse(input),
      ),
    );
  }

  async closeTab(input: c.BrowserCloseTabInput): Promise<c.BrowserActionResult> {
    return c.browserActionResultSchema.parse(
      await this.callTool("browser_close_tab", c.browserCloseTabInputSchema.parse(input)),
    );
  }

  async finishTask(
    input: c.BrowserFinishTaskInput,
  ): Promise<c.BrowserFinishTaskResult> {
    return c.browserFinishTaskResultSchema.parse(
      await this.callTool(
        "browser_finish_task",
        c.browserFinishTaskInputSchema.parse(input),
      ),
    );
  }

  async download(input: c.BrowserDownloadInput): Promise<c.BrowserDownloadResult> {
    return c.browserDownloadResultSchema.parse(
      await this.callTool("browser_download", c.browserDownloadInputSchema.parse(input)),
    );
  }

  async upload(_input: c.BrowserUploadInput): Promise<c.BrowserUploadResult> {
    throw new Error(
      "Raw upload payloads are not supported by the MCP smoke client; use browser_upload with workspace paths.",
    );
  }

  async console(input: c.BrowserConsoleInput): Promise<c.BrowserConsoleResult> {
    return c.browserConsoleResultSchema.parse(
      await this.callTool("browser_console", c.browserConsoleInputSchema.parse(input)),
    );
  }

  async networkList(
    input: c.BrowserNetworkListInput,
  ): Promise<c.BrowserNetworkResult> {
    const parsed = c.browserNetworkListInputSchema.parse(input);
    return c.browserNetworkResultSchema.parse(
      await this.callTool("browser_network", { action: "list", ...parsed }),
    );
  }

  async networkInspect(
    input: c.BrowserNetworkInspectInput,
  ): Promise<c.BrowserNetworkResult> {
    const parsed = c.browserNetworkInspectInputSchema.parse(input);
    return c.browserNetworkResultSchema.parse(
      await this.callTool("browser_network", { action: "inspect", ...parsed }),
    );
  }

  async traceStart(
    input: c.BrowserTraceInput,
  ): Promise<c.BrowserTraceStartResult> {
    const result = asRecord(
      await this.callTool("browser_trace", {
        action: "start",
        ...c.browserTraceInputSchema.parse(input),
      }),
      "browser_trace start result",
    );
    return c.browserTraceStartResultSchema.parse(withoutAction(result));
  }

  async traceStop(
    input: c.BrowserTraceInput,
  ): Promise<c.BrowserTraceStopResult> {
    const result = asRecord(
      await this.callTool("browser_trace", {
        action: "stop",
        ...c.browserTraceInputSchema.parse(input),
      }),
      "browser_trace stop result",
    );
    return c.browserTraceStopResultSchema.parse(withoutAction(result));
  }

  async videoStart(
    input: c.BrowserVideoStartInput,
  ): Promise<c.BrowserVideoStartResult> {
    const result = asRecord(
      await this.callTool("browser_video", {
        action: "start",
        ...c.browserVideoStartInputSchema.parse(input),
      }),
      "browser_video start result",
    );
    return c.browserVideoStartResultSchema.parse(withoutAction(result));
  }

  async videoStop(
    input: c.BrowserVideoStopInput,
  ): Promise<c.BrowserVideoStopResult> {
    const result = asRecord(
      await this.callTool("browser_video", {
        action: "stop",
        ...c.browserVideoStopInputSchema.parse(input),
      }),
      "browser_video stop result",
    );
    return c.browserVideoStopResultSchema.parse(withoutAction(result));
  }

  async pdf(input: c.BrowserPdfInput): Promise<c.BrowserPdfResult> {
    return c.browserPdfResultSchema.parse(
      await this.callTool("browser_pdf", c.browserPdfInputSchema.parse(input)),
    );
  }

  async diagnostics(
    input: c.BrowserDiagnosticsInput,
  ): Promise<c.BrowserDiagnosticsResult> {
    return c.browserDiagnosticsResultSchema.parse(
      await this.callTool(
        "browser_diagnostics",
        c.browserDiagnosticsInputSchema.parse(input),
      ),
    );
  }

  private async callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.request("tools/call", {
      name,
      arguments: arguments_,
    });
    if (result.isError === true) {
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((entry) => asRecord(entry, "tool content").text)
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      throw new Error(`${name} failed${text ? `: ${text}` : "."}`);
    }
    return result.structuredContent;
  }

  private async request(
    method: "tools/list" | "tools/call",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(this.mcpPath, this.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = asRecord(await response.json(), "MCP response");
    if (response.status !== 200) {
      throw new Error(`MCP request returned HTTP ${response.status}.`);
    }
    if (payload.error !== undefined) {
      throw new Error(`MCP protocol error: ${JSON.stringify(payload.error)}`);
    }
    return asRecord(payload.result, "MCP response.result");
  }
}

function withoutAction(value: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...result } = value;
  return result;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}
