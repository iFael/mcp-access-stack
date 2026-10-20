import { describe, expect, it } from "@jest/globals";
import { PersonalBrowserSnapshotState } from "../../../src/companion/personal-browser-snapshot-state.js";

function snapshot(content: string, pageInstanceId?: string) {
  return {
    tabId: "personal:7",
    url: "https://example.test/",
    ...(pageInstanceId ? { pageInstanceId } : {}),
    content,
    refs: [{ ref: "p-7", role: "button", name: "Continue" }],
  };
}

describe("personal Chrome snapshot state", () => {
  it("tracks full, unchanged and concise deltas without dropping actionable refs", () => {
    const tracker = new PersonalBrowserSnapshotState();
    const initial = '- button "Continue" [ref=p-7]\n- status "Ready"\n- paragraph "' + "Unchanged context ".repeat(15) + '"';
    const first = tracker.observe(snapshot(initial, "doc-one"), { tabId: "personal:7" });
    expect(first.state).toMatchObject({ documentId: "doc-one", revision: 1, kind: "full", refsValid: true });
    const unchanged = tracker.observe(snapshot(initial, "doc-one"), {
      tabId: "personal:7", knownRevision: 1,
    });
    expect(unchanged).toMatchObject({ content: "", refs: snapshot(initial).refs,
      state: { revision: 1, baseRevision: 1, kind: "unchanged" } });
    const changed = tracker.observe(snapshot(initial.replace("Ready", "Done"), "doc-one"), {
      tabId: "personal:7", knownRevision: 1,
    });
    expect(changed.state).toMatchObject({ kind: "delta", revision: 2, baseRevision: 1 });
    expect(changed.content).toContain("Done");
    expect(changed.refs).toHaveLength(1);
    const forced = tracker.observe(snapshot(initial, "doc-one"), {
      tabId: "personal:7", knownRevision: 2, forceFull: true,
    });
    expect(forced.state?.kind).toBe("full");
  });

  it("refuses revision reuse after same-URL reloads and absent extension identity", () => {
    const tracker = new PersonalBrowserSnapshotState();
    tracker.observe(snapshot("one", "doc-one"), { tabId: "personal:7" });
    const newDoc = tracker.observe(snapshot("one", "doc-two"), {
      tabId: "personal:7", knownRevision: 1,
    });
    expect(newDoc.state).toMatchObject({ documentId: "doc-two", revision: 2, kind: "full" });
    const legacy = tracker.observe(snapshot("one"), { tabId: "personal:7", knownRevision: 2 });
    expect(legacy.state).toBeUndefined();
    const again = tracker.observe(snapshot("one", "doc-two"), { tabId: "personal:7", knownRevision: 2 });
    expect(again.state?.kind).toBe("full");
  });

  it("clears state when a tab is released", () => {
    const tracker = new PersonalBrowserSnapshotState();
    tracker.observe(snapshot("ready", "doc-one"), { tabId: "personal:7" });
    tracker.discard("personal:7");
    const fresh = tracker.observe(snapshot("ready", "doc-one"), {
      tabId: "personal:7", knownRevision: 1,
    });
    expect(fresh.state?.kind).toBe("full");
  });
});
