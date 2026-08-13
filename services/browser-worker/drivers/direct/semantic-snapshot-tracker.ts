import { randomUUID } from "node:crypto";
import type {
  BrowserStateEvent,
  BrowserStateUpdate,
} from "@vs-code-gpt/shared";
import type { Page } from "playwright";

const DEFAULT_HISTORY_LIMIT = 32;
const DEFAULT_EVENT_LIMIT = 500;

interface RevisionEntry {
  revision: number;
  content?: string;
  eventSequence: number;
}

interface PageSnapshotState {
  documentId: string;
  revision: number;
  history: RevisionEntry[];
  events: BrowserStateEvent[];
  nextEventSequence: number;
}

export interface SemanticSnapshotCapture {
  update: BrowserStateUpdate;
  fullContent: string;
  referenceMode: "replace" | "merge" | "unchanged";
}

export interface SemanticSnapshotCaptureOptions {
  knownRevision?: number;
  forceFull?: boolean;
  snapshot(): Promise<string>;
  trackedSnapshot?(): Promise<
    string | { content: string; kind: "delta" | "full" }
  >;
}

export class SemanticSnapshotTracker {
  private readonly pages = new WeakMap<Page, PageSnapshotState>();

  constructor(
    private readonly historyLimit = DEFAULT_HISTORY_LIMIT,
    private readonly eventLimit = DEFAULT_EVENT_LIMIT,
  ) {}

  invalidate(page: Page): void {
    const existing = this.pages.get(page);
    this.pages.set(page, {
      documentId: randomUUID(),
      revision: 0,
      history: [],
      events: existing?.events.slice(-this.eventLimit) ?? [],
      nextEventSequence: existing?.nextEventSequence ?? 0,
    });
  }

  discard(page: Page): void {
    this.pages.delete(page);
  }

  recordEvent(
    page: Page,
    event: Omit<BrowserStateEvent, "sequence" | "timestamp"> & {
      timestamp?: string;
    },
  ): void {
    const state = this.state(page);
    state.nextEventSequence += 1;
    state.events.push({
      ...event,
      sequence: state.nextEventSequence,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
    if (state.events.length > this.eventLimit) {
      state.events.splice(0, state.events.length - this.eventLimit);
    }
  }

  async capture(
    page: Page,
    options: SemanticSnapshotCaptureOptions,
  ): Promise<SemanticSnapshotCapture> {
    const state = this.state(page);
    const latestBeforeCapture = state.history.at(-1);
    const requestedBase = options.knownRevision === undefined
      ? undefined
      : state.history.find((entry) => entry.revision === options.knownRevision);
    const canUseTrackedSnapshot =
      options.forceFull !== true &&
      options.trackedSnapshot !== undefined &&
      latestBeforeCapture !== undefined &&
      requestedBase?.revision === latestBeforeCapture.revision;
    let prefetchedFullContent: string | undefined;

    if (canUseTrackedSnapshot) {
      const tracked = await options.trackedSnapshot!();
      if (typeof tracked !== "string" && tracked.kind === "full") {
        prefetchedFullContent = normalizeSnapshot(tracked.content);
      }
      const delta = prefetchedFullContent === undefined
        ? normalizeSnapshot(
            typeof tracked === "string" ? tracked : tracked.content,
          )
        : undefined;
      if (delta === undefined) {
        // The private Playwright optimization became unavailable. Continue
        // through the full-snapshot path without losing this action's state.
      }
      else {
      const eventsChanged =
        requestedBase.eventSequence !== state.nextEventSequence;
      if (delta.length > 0 || eventsChanged) {
        state.revision += 1;
        state.history.push({
          revision: state.revision,
          eventSequence: state.nextEventSequence,
        });
        this.trimHistory(state);
      }
      const current = state.history.at(-1) ?? requestedBase;
      if (current.revision === requestedBase.revision) {
        return {
          fullContent: "",
          referenceMode: "unchanged",
          update: {
            documentId: state.documentId,
            revision: current.revision,
            baseRevision: requestedBase.revision,
            kind: "unchanged",
            events: eventsAfter(state.events, requestedBase.eventSequence),
            refsValid: true,
          },
        };
      }
      return {
        fullContent: delta,
        referenceMode: delta.length > 0 ? "merge" : "unchanged",
        update: {
          documentId: state.documentId,
          revision: current.revision,
          baseRevision: requestedBase.revision,
          kind: "delta",
          ...(delta.length > 0 ? { snapshot: delta } : {}),
          events: eventsAfter(state.events, requestedBase.eventSequence),
          refsValid: true,
        },
      };
      }
    }

    const fullContent = prefetchedFullContent ??
      normalizeSnapshot(await options.snapshot());
    const latest = state.history.at(-1);
    const contentChanged = latest?.content !== fullContent;
    const eventsChanged =
      latest !== undefined &&
      latest.eventSequence !== state.nextEventSequence;

    if (!latest || contentChanged || eventsChanged) {
      state.revision += 1;
      state.history.push({
        revision: state.revision,
        content: fullContent,
        eventSequence: state.nextEventSequence,
      });
      this.trimHistory(state);
    }

    const current = state.history.at(-1) ?? {
      revision: state.revision,
      content: fullContent,
      eventSequence: state.nextEventSequence,
    };
    const fullRequestedBase = options.knownRevision === undefined
      ? undefined
      : state.history.find((entry) => entry.revision === options.knownRevision);
    const forceFull =
      options.forceFull === true ||
      options.knownRevision === undefined ||
      fullRequestedBase === undefined ||
      fullRequestedBase.content === undefined;

    if (forceFull) {
      return {
        fullContent,
        referenceMode: "replace",
        update: {
          documentId: state.documentId,
          revision: current.revision,
          kind: "full",
          snapshot: fullContent,
          events: [...state.events],
          refsValid: true,
        },
      };
    }

    const base = fullRequestedBase;
    if (base.revision === current.revision) {
      return {
        fullContent,
        referenceMode: "unchanged",
        update: {
          documentId: state.documentId,
          revision: current.revision,
          baseRevision: base.revision,
          kind: "unchanged",
          events: eventsAfter(state.events, base.eventSequence),
          refsValid: true,
        },
      };
    }

    if (base.content === undefined || current.content === undefined) {
      return {
        fullContent,
        referenceMode: "replace",
        update: {
          documentId: state.documentId,
          revision: current.revision,
          kind: "full",
          snapshot: fullContent,
          events: [...state.events],
          refsValid: true,
        },
      };
    }

    if (base.content === current.content) {
      return {
        fullContent,
        referenceMode: "unchanged",
        update: {
          documentId: state.documentId,
          revision: current.revision,
          baseRevision: base.revision,
          kind: "delta",
          events: eventsAfter(state.events, base.eventSequence),
          refsValid: true,
        },
      };
    }

    const delta = createReadableDelta(base.content, current.content);
    const useFull = delta.length >= current.content.length * 0.8;
    return {
      fullContent,
      referenceMode: useFull ? "replace" : "merge",
      update: {
        documentId: state.documentId,
        revision: current.revision,
        baseRevision: base.revision,
        kind: useFull ? "full" : "delta",
        snapshot: useFull ? current.content : delta,
        events: eventsAfter(state.events, base.eventSequence),
        refsValid: true,
      },
    };
  }

  private trimHistory(state: PageSnapshotState): void {
    if (state.history.length > this.historyLimit) {
      state.history.splice(0, state.history.length - this.historyLimit);
    }
  }

  private state(page: Page): PageSnapshotState {
    let state = this.pages.get(page);
    if (!state) {
      state = {
        documentId: randomUUID(),
        revision: 0,
        history: [],
        events: [],
        nextEventSequence: 0,
      };
      this.pages.set(page, state);
    }
    return state;
  }
}

function eventsAfter(
  events: readonly BrowserStateEvent[],
  sequence: number,
): BrowserStateEvent[] {
  return events.filter((event) => event.sequence > sequence);
}

function normalizeSnapshot(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function createReadableDelta(previous: string, current: string): string {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const lines = [
    `@@ snapshot lines ${prefix + 1}-${Math.max(prefix + 1, after.length - suffix)} @@`,
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ];
  return lines.join("\n").trim();
}
