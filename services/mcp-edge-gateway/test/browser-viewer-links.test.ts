import { describe, expect, it } from "@jest/globals";
import { addBrowserViewerLinks } from "../src/control-plane/browser-viewer-links.js";

describe("browser viewer links", () => {
  it("adds a video artifact link without exposing a local path", () => {
    const response = {
      result: {
        content: [] as Array<{ type: string; text: string }>,
        structuredContent: {
          action: "stop",
          tabId: "tab-1",
          taskId: "task-1",
          kind: "video",
          artifactId: "11111111-1111-4111-8111-111111111111",
          path: "/private/server/recording.mp4",
        },
      },
    };
    expect(addBrowserViewerLinks(response, "https://edge.example/", {
      kind: "device", deviceId: "dev_11111111-1111-4111-8111-111111111111",
    })).toBe(1);
    expect(response.result.structuredContent).toHaveProperty("viewerUrl",
      "https://edge.example/viewer/device/dev_11111111-1111-4111-8111-111111111111/task-1/tab-1/artifact/11111111-1111-4111-8111-111111111111");
    expect(response.result.content[0]?.text).not.toContain("/private/server");
  });

  it("adds credential-free links only to owned task tabs", () => {
    const sourceRuntime =
      "rt_11111111-1111-4111-8111-111111111111";
    const browserEpoch =
      "33333333-3333-4333-8333-333333333333";
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "2 tabs" }],
        structuredContent: {
          tabs: [
            {
              tabId: "tab-1",
              taskId: "task-1",
              ownership: "mcp",
            },
            { tabId: "tab-2", ownership: "user" },
          ],
        },
      },
    };

    expect(
      addBrowserViewerLinks(
        response,
        "https://edge.example/",
        {
          kind: "runtime",
          runtimeId: sourceRuntime,
          browserEpoch,
        },
      ),
    ).toBe(1);
    expect(response.result.structuredContent.tabs[0]).toMatchObject({
      viewerUrl:
        `https://edge.example/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-1`,
    });
    expect(response.result.structuredContent.tabs[1]).not.toHaveProperty(
      "viewerUrl",
    );
    expect(response.result.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        `https://edge.example/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-1`,
      ),
    });
    expect(JSON.stringify(response)).not.toContain("token=");
  });
});
