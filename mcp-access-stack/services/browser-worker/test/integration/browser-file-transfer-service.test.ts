import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Page } from "playwright";
import {
  BrowserFileTransferService,
  type BrowserUploadContext,
} from "../../services/browser-file-transfer-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const tab = {
  tabId: "tab-smoke",
  ownership: "mcp" as const,
  purpose: "file-transfer-test",
  reusable: false,
  protected: false,
  sticky: false,
  createdAt: "2026-07-23T00:00:00.000Z",
  lastUsedAt: "2026-07-23T00:00:00.000Z",
};

describe("BrowserFileTransferService", () => {
  it("downloads through a direct URL and saves inside private storage", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = fakePage(directory);
    const service = new BrowserFileTransferService(directory, {
      currentPage: () => fake.page,
    });

    await expect(
      service.download(
        { tabId: tab.tabId, url: "https://example.test/download" },
        makeContext(),
      ),
    ).resolves.toMatchObject({
      tabId: tab.tabId,
      suggestedFilename: "download.txt",
      sizeBytes: 10,
    });

    expect(fake.goto).toHaveBeenCalledWith(
      "https://example.test/download",
      { waitUntil: "commit" },
    );
    expect(await readFile(path.join(directory, "downloads", fake.savedName), "utf8"))
      .toBe("downloaded");
  });

  it("downloads through an aria reference", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = fakePage(directory);
    const service = new BrowserFileTransferService(directory, {
      currentPage: () => fake.page,
    });

    await service.download(
      { tabId: tab.tabId, ref: "download-ref" },
      makeContext(),
    );

    expect(fake.locator).toHaveBeenCalledWith("aria-ref=download-ref");
    expect(fake.click).toHaveBeenCalledTimes(1);
  });

  it("uploads directly to a selector after authorization", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = fakePage(directory);
    const authorizations: string[] = [];
    const service = new BrowserFileTransferService(directory, {
      currentPage: () => fake.page,
    });

    await expect(
      service.upload(
        {
          tabId: tab.tabId,
          selector: "input[type=file]",
          files: [{
            name: "hello.txt",
            mimeType: "text/plain",
            contentBase64: Buffer.from("hello").toString("base64"),
          }],
        },
        makeContext({
          authorizeUpload: (target) => authorizations.push(target),
        }),
      ),
    ).resolves.toEqual({
      tabId: tab.tabId,
      completed: true,
      fileCount: 1,
      totalBytes: 5,
    });

    expect(authorizations).toEqual(["input[type=file]:hello.txt"]);
    expect(fake.locator).toHaveBeenCalledWith("input[type=file]");
    expect(fake.setInputFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "hello.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello"),
      }),
    ]);
  });

  it("uses a direct file chooser for trigger uploads", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = fakePage(directory);
    const service = new BrowserFileTransferService(directory, {
      currentPage: () => fake.page,
    });

    await service.upload(
      {
        tabId: tab.tabId,
        triggerRef: "upload-button",
        files: [{
          name: "hello.txt",
          contentBase64: Buffer.from("hello").toString("base64"),
        }],
      },
      makeContext(),
    );

    expect(fake.locator).toHaveBeenCalledWith("aria-ref=upload-button");
    expect(fake.click).toHaveBeenCalledTimes(1);
    expect(fake.chooserSetFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: "hello.txt", buffer: Buffer.from("hello") }),
    ]);
  });

  it("rejects malformed base64 before touching the page", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = fakePage(directory);
    const service = new BrowserFileTransferService(directory, {
      currentPage: () => fake.page,
    });

    await expect(
      service.upload(
        {
          tabId: tab.tabId,
          selector: "input[type=file]",
          files: [{ name: "invalid.txt", contentBase64: "not-base64" }],
        },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(fake.locator).not.toHaveBeenCalled();
  });
});

function fakePage(directory: string) {
  const click = jest.fn<() => Promise<void>>(async () => undefined);
  const setInputFiles = jest.fn<(files: unknown) => Promise<void>>(async (_files) => undefined);
  const chooserSetFiles = jest.fn<(files: unknown) => Promise<void>>(async (_files) => undefined);
  const locator = jest.fn<(selector: string) => { click: typeof click; setInputFiles: typeof setInputFiles }>(() => ({ click, setInputFiles }));
  const goto = jest.fn<(url: string, options: unknown) => Promise<null>>(async () => null);
  let savedName = "";
  const download = {
    suggestedFilename: () => "download.txt",
    saveAs: async (output: string) => {
      savedName = path.basename(output);
      await writeFile(output, "downloaded", "utf8");
    },
  };
  const chooser = { setFiles: chooserSetFiles };
  const waitForEvent = jest.fn<(event: string) => Promise<unknown>>(async (event) => {
    if (event === "download") return download;
    if (event === "filechooser") return chooser;
    throw new Error(`Unexpected event: ${event}`);
  });
  const page = {
    locator,
    goto,
    waitForEvent,
  } as unknown as Page;
  return {
    page,
    locator,
    click,
    setInputFiles,
    chooserSetFiles,
    goto,
    get savedName() {
      return savedName;
    },
  };
}

function makeContext(
  overrides: Partial<BrowserUploadContext> = {},
): BrowserUploadContext {
  return {
    tab,
    resolveReference: (ref) => ({ ref, role: "button", name: "Upload" }),
    authorizeUpload: () => undefined,
    ...overrides,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "browser-transfer-service-"),
  );
  directories.push(directory);
  return directory;
}
