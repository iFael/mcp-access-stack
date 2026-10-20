import { describe, expect, it } from "@jest/globals";
import { sanitizeBrowserEvaluation } from "../src/browser-evaluation.js";

describe("browser evaluation sanitizer", () => {
  it("removes credential fields and bearer tokens without exposing raw content", () => {
    expect(sanitizeBrowserEvaluation({
      title: "Public",
      accessToken: "private",
      nested: { password: "secret", authorization: "abc", url: "Bearer super-secret" },
    })).toEqual({
      title: "Public",
      accessToken: "[redacted]",
      nested: { password: "[redacted]", authorization: "[redacted]", url: "[redacted]" },
    });
  });
  it("rejects oversized, cyclic and deeply nested results", () => {
    expect(() => sanitizeBrowserEvaluation({ text: "x".repeat(300000) })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeBrowserEvaluation(cyclic)).toThrow();
  });
});
