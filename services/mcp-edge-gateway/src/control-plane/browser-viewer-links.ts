export type BrowserViewerSource =
  | { kind: "runtime"; runtimeId: string; browserEpoch: string }
  | { kind: "device"; deviceId: string };

export function addBrowserViewerLinks(
  body: unknown,
  publicBaseUrl: string,
  source: BrowserViewerSource,
): number {
  if (
    !isRecord(body) ||
    !isRecord(body.result) ||
    body.result.isError === true ||
    !isRecord(body.result.structuredContent)
  ) {
    return 0;
  }
  const structured = body.result.structuredContent;
  const tabs = Array.isArray(structured.tabs)
    ? structured.tabs
    : isRecord(structured.tab)
      ? [structured.tab]
      : [];
  let added = 0;
  const visibleLinks: string[] = [];
  for (const tab of tabs) {
    if (
      !isRecord(tab) ||
      tab.ownership !== "mcp" ||
      typeof tab.tabId !== "string" ||
      typeof tab.taskId !== "string" ||
      !tab.tabId ||
      !tab.taskId ||
      tab.tabId.length > 128 ||
      tab.taskId.length > 128
    ) {
      continue;
    }
    const route = source.kind === "runtime"
      ? `/viewer/runtime/${encodeURIComponent(source.runtimeId)}/${encodeURIComponent(
          source.browserEpoch,
        )}/${encodeURIComponent(tab.taskId)}/${encodeURIComponent(tab.tabId)}`
      : `/viewer/device/${encodeURIComponent(source.deviceId)}/${encodeURIComponent(
          tab.taskId,
        )}/${encodeURIComponent(tab.tabId)}`;
    tab.viewerUrl = new URL(route, publicBaseUrl).href;
    visibleLinks.push(`${tab.tabId}: ${tab.viewerUrl}`);
    added += 1;
  }
  if (visibleLinks.length > 0 && Array.isArray(body.result.content)) {
    body.result.content.push({
      type: "text",
      text: `Read-only live viewer:\n${visibleLinks.join("\n")}`,
    });
  }
  return added;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
