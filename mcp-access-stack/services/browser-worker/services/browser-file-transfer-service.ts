import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type BrowserDownloadInput,
  type BrowserDownloadResult,
  type BrowserTab,
  type BrowserUploadInput,
  type BrowserUploadResult,
} from "@vs-code-gpt/shared";
import type { Page } from "playwright";

export interface BrowserFileTransferReference {
  ref: string;
  role: string;
  name: string;
}

export interface BrowserDownloadContext {
  tab: BrowserTab;
  resolveReference(ref: string): BrowserFileTransferReference;
}

export interface BrowserUploadContext extends BrowserDownloadContext {
  authorizeUpload(target: string): void;
}

export interface BrowserFileTransferDriver {
  currentPage(): Page;
}

export class BrowserFileTransferService {
  constructor(
    private readonly privateDirectory: string,
    private readonly driver: BrowserFileTransferDriver,
  ) {}

  async download(
    input: BrowserDownloadInput,
    context: BrowserDownloadContext,
  ): Promise<BrowserDownloadResult> {
    const page = this.driver.currentPage();
    const downloadPromise = page.waitForEvent("download");
    let trigger: Promise<unknown>;
    if (input.ref) {
      const reference = context.resolveReference(input.ref);
      trigger = page.locator(`aria-ref=${reference.ref}`).click();
    } else if (input.url) {
      trigger = page.goto(input.url, { waitUntil: "commit" });
    } else {
      throw new AppError(
        "INVALID_ARGUMENT",
        "A direct download requires ref or url.",
      );
    }
    const [download] = await Promise.all([
      downloadPromise,
      trigger.catch((error: unknown) => {
        if (!isDownloadNavigationAbort(error)) throw error;
      }),
    ]);
    const filename = safeDownloadFilename(download.suggestedFilename());
    const output = path.join(
      this.privateDirectory,
      "downloads",
      `${Date.now()}-${filename}`,
    );
    await mkdir(path.dirname(output), { recursive: true });
    await download.saveAs(output);
    const metadata = await stat(output);
    return {
      tabId: context.tab.tabId,
      path: output,
      suggestedFilename: filename,
      sizeBytes: metadata.size,
    };
  }

  async upload(
    input: BrowserUploadInput,
    context: BrowserUploadContext,
  ): Promise<BrowserUploadResult> {
    const target =
      input.inputRef ?? input.selector ?? input.triggerRef ?? "input[type=file]";
    const names = input.files.map((file) => file.name).join(",");
    context.authorizeUpload((target + ":" + names).slice(0, 1_000));

    const decoded = input.files.map((file) => ({
      ...file,
      contents: decodeUploadFile(file.contentBase64),
    }));
    const totalBytes = decoded.reduce(
      (total, file) => total + file.contents.byteLength,
      0,
    );
    const page = this.driver.currentPage();
    const payloads = decoded.map((file) => ({
      name: file.name,
      mimeType: file.mimeType ?? "application/octet-stream",
      buffer: file.contents,
    }));
    if (input.triggerRef) {
      const reference = context.resolveReference(input.triggerRef);
      const chooserPromise = page.waitForEvent("filechooser");
      await page.locator(`aria-ref=${reference.ref}`).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(payloads);
    } else {
      const locator = input.inputRef
        ? page.locator(
            `aria-ref=${context.resolveReference(input.inputRef).ref}`,
          )
        : page.locator(input.selector ?? 'input[type="file"]');
      await locator.setInputFiles(payloads);
    }
    return {
      tabId: context.tab.tabId,
      completed: true,
      fileCount: decoded.length,
      totalBytes,
    };
  }
}

function decodeUploadFile(contentBase64: string): Buffer {
  if (contentBase64.length === 0) return Buffer.alloc(0);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      contentBase64,
    )
  ) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Upload file content must be valid base64.",
    );
  }
  return Buffer.from(contentBase64, "base64");
}

function safeDownloadFilename(value: string): string {
  const filename = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return filename || "download.bin";
}

function isDownloadNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /download|navigation.*aborted|net::ERR_ABORTED/i.test(message);
}
