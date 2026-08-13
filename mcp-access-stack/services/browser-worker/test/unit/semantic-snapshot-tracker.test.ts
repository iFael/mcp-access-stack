import { describe, expect, it } from "@jest/globals";
import type { Page } from "playwright";
import { SemanticSnapshotTracker } from "../../drivers/direct/semantic-snapshot-tracker.js";

describe("SemanticSnapshotTracker", () => {
  it("returns full, unchanged and delta states against a client revision", async () => {
    const tracker = new SemanticSnapshotTracker();
    const page = {} as Page;
    let content = '- textbox "Name" [ref=e1]';

    const first = await tracker.capture(page, {
      snapshot: async () => content,
    });
    expect(first.update).toMatchObject({
      revision: 1,
      kind: "full",
      refsValid: true,
    });

    const unchanged = await tracker.capture(page, {
      knownRevision: 1,
      snapshot: async () => content,
    });
    expect(unchanged.update).toMatchObject({
      revision: 1,
      baseRevision: 1,
      kind: "unchanged",
    });
    expect(unchanged.update.snapshot).toBeUndefined();

    content = [
      '- textbox "Name" [ref=e1]',
      '- button "Continue" [ref=e2]',
    ].join("\n");
    const changed = await tracker.capture(page, {
      knownRevision: 1,
      snapshot: async () => content,
    });
    expect(changed.update.revision).toBe(2);
    expect(["delta", "full"]).toContain(changed.update.kind);
    expect(changed.update.snapshot).toContain("Continue");
  });

  it("attaches only new events and invalidates revisions on navigation", async () => {
    const tracker = new SemanticSnapshotTracker();
    const page = {} as Page;
    const first = await tracker.capture(page, {
      snapshot: async () => '- button "Open" [ref=e1]',
    });
    tracker.recordEvent(page, {
      type: "response",
      url: "https://example.com/api",
      status: 200,
    });

    const eventOnly = await tracker.capture(page, {
      knownRevision: first.update.revision,
      snapshot: async () => '- button "Open" [ref=e1]',
    });
    expect(eventOnly.update).toMatchObject({
      kind: "delta",
      events: [expect.objectContaining({ type: "response", status: 200 })],
    });

    const documentId = eventOnly.update.documentId;
    tracker.invalidate(page);
    const navigated = await tracker.capture(page, {
      knownRevision: eventOnly.update.revision,
      snapshot: async () => '- heading "New page"',
    });
    expect(navigated.update.kind).toBe("full");
    expect(navigated.update.documentId).not.toBe(documentId);
  });

  it("uses tracked deltas only for a current revision and preserves forceFull", async () => {
    const tracker = new SemanticSnapshotTracker();
    const page = {} as Page;
    let fullContent = '- button "Increment" [ref=e1]\n- status [ref=e2]: "0"';
    let trackedContent = "";

    const first = await tracker.capture(page, {
      snapshot: async () => fullContent,
      trackedSnapshot: async () => trackedContent,
    });
    expect(first.update).toMatchObject({ revision: 1, kind: "full" });
    expect(first.referenceMode).toBe("replace");

    const unchanged = await tracker.capture(page, {
      knownRevision: 1,
      snapshot: async () => fullContent,
      trackedSnapshot: async () => trackedContent,
    });
    expect(unchanged.update).toMatchObject({
      revision: 1,
      baseRevision: 1,
      kind: "unchanged",
    });
    expect(unchanged.fullContent).toBe("");
    expect(unchanged.referenceMode).toBe("unchanged");

    trackedContent =
      '- <changed> generic [ref=e1]:\n  - status [ref=e2]: "1"';
    const changed = await tracker.capture(page, {
      knownRevision: 1,
      snapshot: async () => fullContent,
      trackedSnapshot: async () => trackedContent,
    });
    expect(changed.update).toMatchObject({
      revision: 2,
      baseRevision: 1,
      kind: "delta",
      snapshot: trackedContent,
    });
    expect(changed.referenceMode).toBe("merge");

    fullContent = '- button "Increment" [ref=e1]\n- status [ref=e2]: "1"';
    const forced = await tracker.capture(page, {
      knownRevision: 2,
      forceFull: true,
      snapshot: async () => fullContent,
      trackedSnapshot: async () => "",
    });
    expect(forced.update.kind).toBe("full");
    expect(forced.update.snapshot).toBe(fullContent);
    expect(forced.fullContent).toBe(fullContent);
    expect(forced.referenceMode).toBe("replace");
  });
});
