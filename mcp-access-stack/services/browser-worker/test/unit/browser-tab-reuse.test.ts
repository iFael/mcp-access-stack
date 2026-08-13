import { describe, expect, it } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import {
  ABOUT_BLANK_URL,
  browserDocumentIdentity,
  normalizeBrowserUrl,
  selectExactTabReuse,
  selectRecyclableTab,
} from "../../domain/browser-tab-reuse.js";

const baseTab: BrowserTab = {
  tabId: "tab-a",
  taskId: "task-a",
  lifecycle: "task-scoped",
  ownership: "mcp",
  purpose: "research",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: "2026-08-06T12:00:00.000Z",
  lastUsedAt: "2026-08-06T12:00:00.000Z",
  url: "https://example.com/final",
  requestedUrl: "https://example.com/requested",
  title: "Example",
};

describe("browser tab reuse policy", () => {
  it("normalizes scheme, host, default port and dot segments without changing query order", () => {
    expect(
      normalizeBrowserUrl("HTTPS://Example.COM:443/a/../b?z=2&a=1#section"),
    ).toBe("https://example.com/b?z=2&a=1#section");
    expect(browserDocumentIdentity("https://example.com/b#one")).toBe(
      browserDocumentIdentity("https://example.com/b#two"),
    );
    expect(browserDocumentIdentity("https://example.com/b?a=1&b=2")).not.toBe(
      browserDocumentIdentity("https://example.com/b?b=2&a=1"),
    );
  });

  it("reuses a redirected tab by its requested URL without navigating again", () => {
    const match = selectExactTabReuse([baseTab], {
      targetUrl: "https://example.com/requested",
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
    });

    expect(match).toMatchObject({
      source: "requested",
      shouldNavigate: false,
      tab: { tabId: "tab-a" },
    });
  });

  it("reuses the same document but navigates when only the fragment changes", () => {
    const match = selectExactTabReuse([{
      ...baseTab,
      url: "https://example.com/page#one",
      requestedUrl: "https://example.com/page#one",
    }], {
      targetUrl: "https://example.com/page#two",
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
    });

    expect(match).toMatchObject({
      source: "requested",
      shouldNavigate: true,
      tab: { tabId: "tab-a" },
    });
  });

  it("does not treat a transient about:blank as the logical identity", () => {
    const tab = {
      ...baseTab,
      url: ABOUT_BLANK_URL,
      requestedUrl: "https://example.com/requested",
    };
    expect(selectExactTabReuse([tab], {
      targetUrl: ABOUT_BLANK_URL,
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
    })).toBeUndefined();
    expect(selectExactTabReuse([tab], {
      targetUrl: "https://example.com/requested",
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
    })).toMatchObject({ shouldNavigate: true });
  });

  it("allows exact reuse for dedicated and sticky tabs but never recycles them", () => {
    const dedicated = { ...baseTab, reusable: false };
    const sticky = {
      ...baseTab,
      tabId: "tab-sticky",
      reusable: false,
      protected: true,
      sticky: true,
      lockedUrl: "https://example.com/requested",
    };

    expect(selectExactTabReuse([dedicated], {
      targetUrl: "https://example.com/requested",
      purpose: "research",
      reusable: false,
      protected: false,
      sticky: false,
    })?.tab.tabId).toBe("tab-a");
    expect(selectExactTabReuse([sticky], {
      targetUrl: "https://example.com/requested",
      purpose: "research",
      reusable: false,
      protected: true,
      sticky: true,
    })?.tab.tabId).toBe("tab-sticky");
    expect(selectRecyclableTab([dedicated, sticky], {
      targetUrl: "https://example.com/other",
      purpose: "other",
      reusable: true,
      protected: false,
      sticky: false,
    })).toBeUndefined();
  });

  it("selects recyclable tabs deterministically", () => {
    const selected = selectRecyclableTab([
      {
        ...baseTab,
        tabId: "tab-z",
        requestedUrl: ABOUT_BLANK_URL,
        url: ABOUT_BLANK_URL,
        purpose: "mcp-default",
        lastUsedAt: "2026-08-06T12:00:00.000Z",
      },
      {
        ...baseTab,
        tabId: "tab-a",
        requestedUrl: "https://example.com/old",
        url: "https://example.com/old",
        lastUsedAt: "2026-08-06T11:00:00.000Z",
      },
    ], {
      targetUrl: "https://example.com/new",
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
    });

    expect(selected?.tab.tabId).toBe("tab-z");
  });
});
