import type { BrowserTab } from "@vs-code-gpt/shared";

export const ABOUT_BLANK_URL = "about:blank";

export interface BrowserTabReuseRequest {
  targetUrl: string;
  purpose: string;
  reusable: boolean;
  protected: boolean;
  sticky: boolean;
}

export interface BrowserTabReuseMatch {
  tab: BrowserTab;
  source: "locked" | "requested" | "current" | "none";
  shouldNavigate: boolean;
}

export function normalizeBrowserUrl(value: string): string {
  return new URL(value).href;
}

export function browserDocumentIdentity(value: string): string {
  const url = new URL(normalizeBrowserUrl(value));
  if (url.href === ABOUT_BLANK_URL) return ABOUT_BLANK_URL;
  url.hash = "";
  return url.href;
}

export function selectExactTabReuse(
  tabs: readonly BrowserTab[],
  request: BrowserTabReuseRequest,
): BrowserTabReuseMatch | undefined {
  const candidates = tabs
    .filter((tab) => sameConfiguration(tab, request))
    .map((tab) => matchTabTarget(tab, request.targetUrl))
    .filter((match): match is BrowserTabReuseMatch => match !== undefined)
    .sort(compareExactMatches);
  return candidates[0];
}

export function selectRecyclableTab(
  tabs: readonly BrowserTab[],
  request: BrowserTabReuseRequest,
): BrowserTabReuseMatch | undefined {
  const candidates = tabs
    .filter((tab) => tab.reusable && !tab.protected && !tab.sticky)
    .map((tab) => {
      const targetMatch = matchTabTarget(tab, request.targetUrl);
      return targetMatch ?? {
        tab,
        source: "none" as const,
        shouldNavigate:
          normalizeBrowserUrl(tab.url ?? ABOUT_BLANK_URL) !== request.targetUrl,
      };
    })
    .sort(compareRecyclableMatches);
  return candidates[0];
}

export function isLogicalBlankTab(tab: BrowserTab): boolean {
  const requestedUrl = normalizedOptional(tab.requestedUrl);
  if (requestedUrl !== undefined) return requestedUrl === ABOUT_BLANK_URL;
  return normalizeBrowserUrl(tab.url ?? ABOUT_BLANK_URL) === ABOUT_BLANK_URL;
}

function sameConfiguration(
  tab: BrowserTab,
  request: BrowserTabReuseRequest,
): boolean {
  return (
    tab.purpose === request.purpose &&
    tab.reusable === request.reusable &&
    tab.protected === request.protected &&
    tab.sticky === request.sticky
  );
}

function matchTabTarget(
  tab: BrowserTab,
  targetUrl: string,
): BrowserTabReuseMatch | undefined {
  const target = normalizeBrowserUrl(targetUrl);
  const targetDocument = browserDocumentIdentity(target);
  const lockedUrl = normalizedOptional(tab.lockedUrl);
  if (
    tab.sticky &&
    lockedUrl !== undefined &&
    browserDocumentIdentity(lockedUrl) === targetDocument
  ) {
    return {
      tab,
      source: "locked",
      shouldNavigate: shouldNavigateFromLogicalUrl(tab, lockedUrl, target),
    };
  }

  const requestedUrl = normalizedOptional(tab.requestedUrl);
  if (
    requestedUrl !== undefined &&
    browserDocumentIdentity(requestedUrl) === targetDocument
  ) {
    return {
      tab,
      source: "requested",
      shouldNavigate: shouldNavigateFromLogicalUrl(tab, requestedUrl, target),
    };
  }

  const currentUrl = normalizeBrowserUrl(tab.url ?? ABOUT_BLANK_URL);
  const currentCanIdentifyTarget =
    currentUrl !== ABOUT_BLANK_URL ||
    requestedUrl === undefined ||
    requestedUrl === ABOUT_BLANK_URL;
  if (
    currentCanIdentifyTarget &&
    browserDocumentIdentity(currentUrl) === targetDocument
  ) {
    return {
      tab,
      source: "current",
      shouldNavigate: currentUrl !== target,
    };
  }
  return undefined;
}

function shouldNavigateFromLogicalUrl(
  tab: BrowserTab,
  logicalUrl: string,
  targetUrl: string,
): boolean {
  const currentUrl = normalizeBrowserUrl(tab.url ?? ABOUT_BLANK_URL);
  if (targetUrl === ABOUT_BLANK_URL) return currentUrl !== ABOUT_BLANK_URL;
  if (currentUrl === ABOUT_BLANK_URL) return true;
  return logicalUrl !== targetUrl;
}

function compareExactMatches(
  left: BrowserTabReuseMatch,
  right: BrowserTabReuseMatch,
): number {
  return (
    sourceRank(left.source) - sourceRank(right.source) ||
    right.tab.lastUsedAt.localeCompare(left.tab.lastUsedAt) ||
    left.tab.tabId.localeCompare(right.tab.tabId)
  );
}

function compareRecyclableMatches(
  left: BrowserTabReuseMatch,
  right: BrowserTabReuseMatch,
): number {
  return (
    recyclableRank(left) - recyclableRank(right) ||
    left.tab.lastUsedAt.localeCompare(right.tab.lastUsedAt) ||
    left.tab.tabId.localeCompare(right.tab.tabId)
  );
}

function recyclableRank(match: BrowserTabReuseMatch): number {
  if (match.source !== "none") return 0;
  if (match.tab.purpose === "mcp-default" && isLogicalBlankTab(match.tab)) {
    return 1;
  }
  return 2;
}

function sourceRank(source: BrowserTabReuseMatch["source"]): number {
  switch (source) {
    case "locked":
    case "requested":
      return 0;
    case "current":
      return 1;
    case "none":
      return 2;
  }
}

function normalizedOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeBrowserUrl(value);
}
