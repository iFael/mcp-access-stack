import { describe, expect, it } from "@jest/globals";
import { summarizeCdpAccessibility } from "../../../src/companion/personal-browser-accessibility.js";

const tree = [
  { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Document" }, childIds: ["heading", "form"] },
  { nodeId: "heading", role: { value: "heading" }, name: { value: "Welcome" } },
  { nodeId: "form", role: { value: "form" }, childIds: ["input", "button"] },
  { nodeId: "input", role: { value: "textbox" }, name: { value: "Email" },
    value: { value: "extremely-private-credential" }, backendDOMNodeId: 42 },
  { nodeId: "button", role: { value: "button" }, name: { value: "Submit" } },
];

describe("native Chrome accessibility summaries", () => {
  it("maps hierarchy without leaking DOM ids, backend ids or form values", () => {
    const output = summarizeCdpAccessibility(
      { nodes: tree },
      { frameTree: { frame: { id: "main" }, childFrames: [
        { frame: { id: "child" } },
      ] } },
    );
    expect(output).toMatchObject({
      source: "cdp", coverage: "main-frame-only", frameCount: 2, truncated: false,
      nodes: [
        { depth: 0, role: "RootWebArea", name: "Document" },
        { depth: 1, role: "heading", name: "Welcome" },
        { depth: 1, role: "form", name: "" },
        { depth: 2, role: "textbox", name: "Email" },
        { depth: 2, role: "button", name: "Submit" },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("extremely-private-credential");
    expect(JSON.stringify(output)).not.toContain("backendDOMNodeId");
    expect(JSON.stringify(output)).not.toContain("nodeId");
    expect(JSON.stringify(output)).not.toContain('"child"');
  });

  it("limits nodes, names, depth and frame traversal", () => {
    const nodes = Array.from({ length: 1400 }, (_, i) => ({
      nodeId: String(i), role: { value: "button" },
      name: { value: "a".repeat(2000) },
      ...(i < 1399 ? { childIds: [String(i + 1)] } : {}),
    }));
    const output = summarizeCdpAccessibility({ nodes }, { frameTree: { frame: { id: "a" } } });
    expect(output.nodes.length).toBeLessThanOrEqual(1000);
    expect(output.nodes.every((n) => n.name.length <= 500 && n.depth <= 40)).toBe(true);
    expect(output.truncated).toBe(true);
  });

  it("rejects missing or invalid native trees rather than silently claiming coverage", () => {
    expect(() => summarizeCdpAccessibility({ nodes: [] }, {})).toThrow();
    expect(() => summarizeCdpAccessibility({ nodes: "invalid" }, {})).toThrow();
  });
});
