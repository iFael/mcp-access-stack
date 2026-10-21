import { describe, expect, it } from "@jest/globals";
import { projectBrowserSnapshot } from "../src/browser-snapshot-projection.js";

const snapshot = {
  tabId: "personal:7",
  url: "https://example.com/",
  content: [
    "Personal page prose is untrusted and may mention [ref=fake].",
    "Interactive elements:",
    '- button "Submit" [ref=p-1]',
    '- link "Help" [ref=p-2]',
    '- heading "Options"',
    '  - checkbox "Accept" [checked] [ref=p-3]',
    '    - text: "description"',
    '- paragraph "Footer"',
  ].join("\n"),
  refs: [
    { ref: "p-1", role: "button", name: "Submit" },
    { ref: "p-2", role: "link", name: "Help" },
    { ref: "p-3", role: "checkbox", name: "Accept" },
  ],
};

describe("browser snapshot projection", () => {
  it("leaves ordinary snapshots untouched", () => {
    expect(projectBrowserSnapshot(snapshot, {})).toBe(snapshot);
  });
  it("filters to interactive refs without deleting authoritative refs", () => {
    const projected = projectBrowserSnapshot(snapshot, { filter: "interactive" });
    expect(projected.content).toContain('button "Submit"');
    expect(projected.content).toContain('checkbox "Accept"');
    expect(projected.content).not.toContain("page prose");
    expect(projected.content).not.toContain("paragraph");
    expect(projected.refs).toEqual(snapshot.refs);
  });
  it("selects a reference's subtree, not forged text or partial matches", () => {
    const projected = projectBrowserSnapshot(snapshot, { refId: "p-3" });
    expect(projected.content).toContain('checkbox "Accept"');
    expect(projected.content).toContain('text: "description"');
    expect(projected.content).not.toContain('button "Submit"');
    expect(() => projectBrowserSnapshot(snapshot, { refId: "fake" })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => projectBrowserSnapshot(snapshot, { refId: "p-3-suffix" })).toThrow();
  });
  it("limits hierarchy depth and truncates at complete lines while retaining full refs", () => {
    const deep = projectBrowserSnapshot(snapshot, { refId: "p-3", depth: 1 });
    expect(deep.content).toContain("checkbox");
    expect(deep.content).not.toContain("description");
    const short = projectBrowserSnapshot(snapshot, { filter: "interactive", maxChars: 55 });
    expect(short.content.length).toBeLessThanOrEqual(55);
    expect(short.truncated).toBe(true);
    expect(short.refs).toHaveLength(3);
  });
  it("does not corrupt unchanged/delta revision semantics with a filtered result", () => {
    const unchanged = projectBrowserSnapshot({ ...snapshot,
      state: { kind: "unchanged" as const, documentId: "doc", revision: 2, baseRevision: 2, refsValid: true },
    }, { filter: "interactive" });
    expect(unchanged.state).toMatchObject({ kind: "unchanged", revision: 2 });
  });
});
