import type {
  BrowserSnapshotInput,
  BrowserSnapshotResult,
  BrowserStateUpdate,
} from "@vs-code-gpt/shared";

interface TrackedPage {
  pageInstanceId: string;
  url: string;
  revision: number;
  lines: string[];
}

/**
 * Tracks only authenticated extension snapshots. Pages without a stable
 * isolated-world pageInstanceId (legacy extension) receive full snapshots;
 * a guessed document ID could incorrectly reuse refs after a same-URL reload.
 */
export class PersonalBrowserSnapshotState {
  private readonly pages = new Map<string, TrackedPage>();

  observe(
    snapshot: BrowserSnapshotResult,
    input: BrowserSnapshotInput,
  ): BrowserSnapshotResult {
    const { tabId, pageInstanceId, url, content } = snapshot;
    if (!pageInstanceId) {
      this.discard(tabId);
      return snapshot;
    }
    const lines = content.split("\n");
    const previous = this.pages.get(tabId);
    const newDocument = !previous ||
      previous.pageInstanceId !== pageInstanceId || previous.url !== url;
    const sameContent = !newDocument && previous.lines.length === lines.length &&
      lines.every((line, index) => line === previous.lines[index]);
    const revision = !previous ? 1 : previous.revision + (newDocument || !sameContent ? 1 : 0);
    this.pages.set(tabId, { pageInstanceId, url, revision, lines });

    let kind: BrowserStateUpdate["kind"] = "full";
    let snapshotText = content;
    const useDelta = !newDocument && input.forceFull !== true &&
      input.knownRevision === previous?.revision;
    if (useDelta && sameContent) {
      kind = "unchanged";
      snapshotText = "";
    } else if (useDelta) {
      const delta = lineDelta(previous!.lines, lines);
      if (delta.length < content.length) {
        kind = "delta";
        snapshotText = delta;
      }
    }
    const state: BrowserStateUpdate = {
      documentId: pageInstanceId,
      revision,
      ...(kind !== "full" ? { baseRevision: previous!.revision } : {}),
      kind,
      ...(kind !== "unchanged" ? { snapshot: snapshotText } : {}),
      refsValid: true,
    };
    return { ...snapshot, content: snapshotText, state };
  }

  discard(tabId: string): void {
    this.pages.delete(tabId);
  }

  clear(): void {
    this.pages.clear();
  }
}

function lineDelta(previous: readonly string[], current: readonly string[]): string {
  let start = 0;
  while (start < previous.length && start < current.length &&
    previous[start] === current[start]) start += 1;
  let endOld = previous.length;
  let endNew = current.length;
  while (endOld > start && endNew > start &&
    previous[endOld - 1] === current[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const changes = current.slice(start, endNew);
  const removed = endOld - start;
  // Explicit bounds avoid returning an ambiguous fragment without an anchor.
  const header = `<changed lines=${start + 1} removed=${removed} added=${changes.length}>`;
  return [header, ...changes].join("\n");
}
