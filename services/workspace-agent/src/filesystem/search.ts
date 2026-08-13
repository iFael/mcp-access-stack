import {
  abortSignalError,
  AppError,
  type SearchFilesResult,
} from "@vs-code-gpt/shared";
import type { FileCandidate } from "./discovery.js";
import { readTextFile } from "./text-file.js";

const SEARCH_FILE_CONCURRENCY = 8;
const SEARCH_LINE_ABORT_CHECK_INTERVAL = 256;

interface FileSearchResult {
  matches: Array<{
    path: string;
    line: number;
    column: number;
    snippet: string;
  }>;
  skipped: boolean;
  hasMoreMatches: boolean;
}

export interface SearchAuthorizedFilesInput {
  files: FileCandidate[];
  query: string;
  caseSensitive: boolean;
  maxFileBytes: number;
  maxSearchResults: number;
  maxSearchSnippetBytes: number;
  initialTruncated: boolean;
  signal?: AbortSignal;
}

export async function searchAuthorizedFiles(
  input: SearchAuthorizedFilesInput,
): Promise<SearchFilesResult> {
  throwIfAborted(input.signal);
  const matches: SearchFilesResult["matches"] = [];
  let snippetBytes = 0;
  let skippedFiles = 0;
  let truncated = input.initialTruncated;
  const query = input.caseSensitive
    ? input.query
    : input.query.toLocaleLowerCase("en-US");

  for (let offset = 0; offset < input.files.length; offset += SEARCH_FILE_CONCURRENCY) {
    throwIfAborted(input.signal);
    const batch = input.files.slice(offset, offset + SEARCH_FILE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((candidate) =>
        searchCandidate(
          candidate,
          query,
          input.caseSensitive,
          input.maxFileBytes,
          input.maxSearchResults,
          input.maxSearchSnippetBytes,
          input.signal,
        ),
      ),
    );
    throwIfAborted(input.signal);

    for (const result of batchResults) {
      throwIfAborted(input.signal);
      if (result.skipped) {
        skippedFiles += 1;
        continue;
      }

      for (const match of result.matches) {
        if (matches.length >= input.maxSearchResults) {
          truncated = true;
          break;
        }

        const remainingSnippetBytes = input.maxSearchSnippetBytes - snippetBytes;
        if (remainingSnippetBytes <= 0) {
          truncated = true;
          break;
        }

        const snippet = truncateUtf8(match.snippet, remainingSnippetBytes);
        snippetBytes += Buffer.byteLength(snippet, "utf8");
        matches.push({ ...match, snippet });
      }

      if (result.hasMoreMatches) {
        truncated = true;
      }
      if (
        matches.length >= input.maxSearchResults ||
        snippetBytes >= input.maxSearchSnippetBytes
      ) {
        truncated = true;
        break;
      }
    }

    if (
      matches.length >= input.maxSearchResults ||
      snippetBytes >= input.maxSearchSnippetBytes
    ) {
      break;
    }
  }

  throwIfAborted(input.signal);
  return { matches, truncated, skippedFiles };
}

async function searchCandidate(
  candidate: FileCandidate,
  query: string,
  caseSensitive: boolean,
  maxFileBytes: number,
  maxMatches: number,
  maxSnippetBytes: number,
  signal?: AbortSignal,
): Promise<FileSearchResult> {
  throwIfAborted(signal);
  let contents: Awaited<ReturnType<typeof readTextFile>>;
  try {
    contents = await readTextFile(candidate.absolutePath, maxFileBytes);
  } catch (error) {
    if (
      error instanceof AppError &&
      ["FILE_TOO_LARGE", "BINARY_FILE"].includes(error.code)
    ) {
      return { matches: [], skipped: true, hasMoreMatches: false };
    }
    throw error;
  }
  throwIfAborted(signal);

  const matches: FileSearchResult["matches"] = [];
  let hasMoreMatches = false;
  const lines = contents.text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex % SEARCH_LINE_ABORT_CHECK_INTERVAL === 0) {
      throwIfAborted(signal);
    }
    const haystack = caseSensitive ? line : line.toLocaleLowerCase("en-US");
    const columnIndex = haystack.indexOf(query);
    if (columnIndex === -1) {
      continue;
    }
    if (matches.length >= maxMatches) {
      hasMoreMatches = true;
      break;
    }
    matches.push({
      path: candidate.logicalPath,
      line: lineIndex + 1,
      column: columnIndex + 1,
      snippet: truncateUtf8(line, maxSnippetBytes),
    });
  }

  throwIfAborted(signal);
  return { matches, skipped: false, hasMoreMatches };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Search operation was cancelled.");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
