import {
  abortSignalError,
  type BrowserExtractionCompleteness,
  type BrowserExtractionCompletionMode,
} from "@vs-code-gpt/shared";

export type BrowserExtractionFormat = "text" | "html" | "json";

export interface BrowserExtractionProbe {
  scrollTop: number;
  viewportSize: number;
  scrollSize: number;
  contentBytes: number;
  signature: string;
  nextUrl?: string;
}

export interface BrowserExtractionCompletenessOptions {
  probe(format: BrowserExtractionFormat): Promise<BrowserExtractionProbe>;
  advanceScroll(): Promise<void>;
  stabilize(): Promise<void>;
  read(format: BrowserExtractionFormat): Promise<unknown>;
  navigateNext?(url: string): Promise<boolean>;
  now?: () => number;
}

export interface BrowserExtractionCompletenessRequest {
  format: BrowserExtractionFormat;
  mode: BrowserExtractionCompletionMode;
  maxScrolls: number;
  maxPages: number;
  maxBytes: number;
  timeoutMs: number;
  noProgressLimit: number;
  signal?: AbortSignal;
}

export interface BrowserCompletedExtraction {
  value: unknown;
  completeness: BrowserExtractionCompleteness;
}

export class BrowserExtractionCompletenessService {
  private readonly now: () => number;

  constructor(private readonly options: BrowserExtractionCompletenessOptions) {
    this.now = options.now ?? Date.now;
  }

  async extract(
    request: BrowserExtractionCompletenessRequest,
  ): Promise<BrowserCompletedExtraction> {
    const maxScrolls = positiveInteger(request.maxScrolls, 1);
    const maxPages = positiveInteger(request.maxPages, 1);
    const maxBytes = positiveInteger(request.maxBytes, 1);
    const noProgressLimit = positiveInteger(request.noProgressLimit, 1);
    const deadline = this.now() + positiveInteger(request.timeoutMs, 1);

    if (request.mode === "visible") {
      assertActive(request.signal);
      await this.options.stabilize();
      const value = truncateValue(
        await this.options.read(request.format),
        request.format,
        maxBytes,
      );
      const bytes = valueBytes(value);
      return {
        value,
        completeness: {
          status: "partial",
          reason: bytes >= maxBytes ? "byte-limit" : "visible-only",
          mode: request.mode,
          pages: 1,
          scrolls: 0,
          bytes,
        },
      };
    }

    let pages = 0;
    let scrolls = 0;
    let totalBytes = 0;
    const pageValues: unknown[] = [];
    const visitedNextUrls = new Set<string>();
    const visitedPageSignatures = new Set<string>();

    while (pages < maxPages) {
      assertActive(request.signal);
      await this.options.stabilize();

      let probe = await this.options.probe(request.format);
      let pageValue = truncateValue(
        await this.options.read(request.format),
        request.format,
        remainingBytes(maxBytes, totalBytes),
      );
      let pageBytes = valueBytes(pageValue);
      let noProgress = 0;
      let virtualized = false;

      if (this.now() >= deadline) {
        return finalizeCurrentPage(
          request,
          pageValues,
          pageValue,
          "time-limit",
          pages,
          scrolls,
          totalBytes,
          Boolean(probe.nextUrl),
        );
      }

      if (reachedByteLimit(maxBytes, totalBytes, pageBytes, probe.contentBytes)) {
        return finalizeCurrentPage(
          request,
          pageValues,
          pageValue,
          "byte-limit",
          pages,
          scrolls,
          totalBytes,
          Boolean(probe.nextUrl),
          maxBytes,
        );
      }

      while (!atEnd(probe)) {
        assertActive(request.signal);
        if (this.now() >= deadline) {
          return finalizeCurrentPage(
            request,
            pageValues,
            pageValue,
            "time-limit",
            pages,
            scrolls,
            totalBytes,
            Boolean(probe.nextUrl),
          );
        }
        if (scrolls >= maxScrolls) {
          return finalizeCurrentPage(
            request,
            pageValues,
            pageValue,
            "scroll-limit",
            pages,
            scrolls,
            totalBytes,
            Boolean(probe.nextUrl),
          );
        }

        const previous = probe;
        await this.options.advanceScroll();
        scrolls += 1;
        await this.options.stabilize();
        probe = await this.options.probe(request.format);

        const sample = truncateValue(
          await this.options.read(request.format),
          request.format,
          remainingBytes(maxBytes, totalBytes),
        );
        pageValue = truncateValue(
          mergeWithinPage(pageValue, sample, request.format),
          request.format,
          remainingBytes(maxBytes, totalBytes),
        );
        pageBytes = valueBytes(pageValue);

        if (
          request.format === "html" &&
          probe.signature !== previous.signature &&
          probe.contentBytes <= previous.contentBytes
        ) {
          virtualized = true;
        }

        const progressed =
          probe.scrollTop > previous.scrollTop ||
          probe.scrollSize > previous.scrollSize ||
          probe.signature !== previous.signature;
        noProgress = progressed ? 0 : noProgress + 1;

        if (this.now() >= deadline) {
          return finalizeCurrentPage(
            request,
            pageValues,
            pageValue,
            "time-limit",
            pages,
            scrolls,
            totalBytes,
            Boolean(probe.nextUrl),
          );
        }
        if (reachedByteLimit(maxBytes, totalBytes, pageBytes, probe.contentBytes)) {
          return finalizeCurrentPage(
            request,
            pageValues,
            pageValue,
            "byte-limit",
            pages,
            scrolls,
            totalBytes,
            Boolean(probe.nextUrl),
            maxBytes,
          );
        }
        if (noProgress >= noProgressLimit && !atEnd(probe)) {
          return finalizeCurrentPage(
            request,
            pageValues,
            pageValue,
            "no-progress",
            pages,
            scrolls,
            totalBytes,
            Boolean(probe.nextUrl),
          );
        }
      }

      pages += 1;
      pageValues.push(pageValue);
      totalBytes += pageBytes;

      if (virtualized) {
        return result(
          request,
          pageValues,
          "partial",
          "virtualized-content",
          pages,
          scrolls,
          totalBytes,
          Boolean(probe.nextUrl),
        );
      }

      if (!probe.nextUrl) {
        return result(
          request,
          pageValues,
          "complete",
          request.mode === "document-and-safe-pagination"
            ? "pagination-end"
            : "end-of-document",
          pages,
          scrolls,
          totalBytes,
          false,
        );
      }

      if (request.mode !== "document-and-safe-pagination") {
        return result(
          request,
          pageValues,
          "partial",
          "pagination-available",
          pages,
          scrolls,
          totalBytes,
          true,
        );
      }

      if (request.format !== "text" || !this.options.navigateNext) {
        return result(
          request,
          pageValues,
          "partial",
          "unsafe-pagination",
          pages,
          scrolls,
          totalBytes,
          true,
        );
      }

      if (pages >= maxPages) {
        return result(
          request,
          pageValues,
          "partial",
          "page-limit",
          pages,
          scrolls,
          totalBytes,
          true,
        );
      }

      if (
        visitedNextUrls.has(probe.nextUrl) ||
        visitedPageSignatures.has(probe.signature)
      ) {
        return result(
          request,
          pageValues,
          "partial",
          "cycle",
          pages,
          scrolls,
          totalBytes,
          true,
        );
      }
      visitedNextUrls.add(probe.nextUrl);
      visitedPageSignatures.add(probe.signature);

      if (!(await this.options.navigateNext(probe.nextUrl))) {
        return result(
          request,
          pageValues,
          "partial",
          "unsafe-pagination",
          pages,
          scrolls,
          totalBytes,
          true,
        );
      }
    }

    return result(
      request,
      pageValues,
      "partial",
      "page-limit",
      Math.max(1, pages),
      scrolls,
      totalBytes,
      false,
    );
  }
}

function finalizeCurrentPage(
  request: BrowserExtractionCompletenessRequest,
  completedPages: readonly unknown[],
  currentPage: unknown,
  reason: BrowserExtractionCompleteness["reason"],
  completedPageCount: number,
  scrolls: number,
  completedBytes: number,
  paginationAvailable: boolean,
  byteCap?: number,
): BrowserCompletedExtraction {
  const values = [...completedPages, currentPage];
  const currentBytes = valueBytes(currentPage);
  const bytes = byteCap === undefined
    ? completedBytes + currentBytes
    : Math.min(byteCap, completedBytes + currentBytes);
  return result(
    request,
    values,
    "partial",
    reason,
    completedPageCount + 1,
    scrolls,
    bytes,
    paginationAvailable,
  );
}

function result(
  request: BrowserExtractionCompletenessRequest,
  pageValues: readonly unknown[],
  status: BrowserExtractionCompleteness["status"],
  reason: BrowserExtractionCompleteness["reason"],
  pages: number,
  scrolls: number,
  bytes: number,
  paginationAvailable: boolean,
): BrowserCompletedExtraction {
  const combinedValue = combinePages(pageValues, request.format);
  const maxBytes = positiveInteger(request.maxBytes, 1);
  const combinedBytes = valueBytes(combinedValue);
  const value = truncateValue(combinedValue, request.format, maxBytes);
  const outputBytes = valueBytes(value);
  const outputWasTruncated = combinedBytes > maxBytes;
  return {
    value,
    completeness: {
      status: outputWasTruncated ? "partial" : status,
      reason: outputWasTruncated ? "byte-limit" : reason,
      mode: request.mode,
      pages,
      scrolls,
      bytes: outputBytes,
      ...(paginationAvailable ? { paginationAvailable: true } : {}),
    },
  };
}

function atEnd(probe: BrowserExtractionProbe): boolean {
  return probe.scrollTop + probe.viewportSize >= probe.scrollSize - 2;
}

function reachedByteLimit(
  maxBytes: number,
  completedBytes: number,
  currentBytes: number,
  rawContentBytes: number,
): boolean {
  return completedBytes + currentBytes >= maxBytes || rawContentBytes >= maxBytes;
}

function remainingBytes(maxBytes: number, completedBytes: number): number {
  return Math.max(1, maxBytes - completedBytes);
}

function mergeWithinPage(
  current: unknown,
  next: unknown,
  format: BrowserExtractionFormat,
): unknown {
  if (format === "text" && typeof current === "string" && typeof next === "string") {
    return mergeOrderedText(current, next);
  }
  if (format === "json" && isTextRecord(current) && isTextRecord(next)) {
    return {
      ...current,
      ...next,
      text: mergeOrderedText(current.text, next.text),
    };
  }
  return next;
}

function combinePages(
  values: readonly unknown[],
  format: BrowserExtractionFormat,
): unknown {
  if (values.length <= 1) return values[0] ?? (format === "json" ? {} : "");
  if (format === "text" && values.every((value) => typeof value === "string")) {
    return (values as string[]).join("\n\n");
  }
  return values.at(-1);
}

function mergeOrderedText(current: string, next: string): string {
  if (!current) return next;
  if (!next || current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  const currentLines = current.split("\n");
  const nextLines = next.split("\n");
  const maxOverlap = Math.min(currentLines.length, nextLines.length, 200);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        currentLines[currentLines.length - overlap + index] !== nextLines[index]
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return [...currentLines, ...nextLines.slice(overlap)].join("\n");
    }
  }
  return `${current}\n${next}`;
}

function truncateValue(
  value: unknown,
  format: BrowserExtractionFormat,
  maxBytes: number,
): unknown {
  if ((format === "text" || format === "html") && typeof value === "string") {
    return truncateString(value, maxBytes);
  }
  if (format === "json" && isTextRecord(value)) {
    const overhead = valueBytes({ ...value, text: "" });
    return {
      ...value,
      text: truncateString(value.text, Math.max(1, maxBytes - overhead)),
    };
  }
  return value;
}

function truncateString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function valueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function isTextRecord(value: unknown): value is Record<string, unknown> & { text: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "text" in value &&
      typeof (value as { text?: unknown }).text === "string",
  );
}

function positiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function assertActive(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortSignalError(signal, "Browser extraction completeness was cancelled.");
}
