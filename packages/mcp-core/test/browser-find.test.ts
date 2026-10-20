import { describe, expect, it } from "@jest/globals";
import { findBrowserElements } from "../src/browser-interaction.js";

const refs = [
  { ref: "r1", role: "button", name: "Enviar solicitação" },
  { ref: "r2", role: "button", name: "Enviar" },
  { ref: "r3", role: "link", name: "Solicitações enviadas" },
  { ref: "r4", role: "textbox", name: "E-mail do solicitante" },
  { ref: "r5", role: "button", name: "Cancelar solicitação" },
];

describe("browser_find deterministic ranking", () => {
  it("ranks exact matches first without inventing references", () => {
    expect(findBrowserElements(refs, "enviar").map((r) => r.ref)).toEqual(["r2", "r1"]);
    expect(findBrowserElements(refs, "enviar solicitacao").map((r) => r.ref)).toEqual(["r1"]);
  });

  it("normalizes accents/case and supports role filters", () => {
    expect(findBrowserElements(refs, "EMAIL", "textbox").map((r) => r.ref)).toEqual(["r4"]);
    expect(findBrowserElements(refs, "solicitacao", "button").map((r) => r.ref)).toEqual(["r1", "r5"]);
    expect(findBrowserElements(refs, "solicitação", "link")).toEqual([]);
  });

  it("bounds results and keeps stable ordering for ties", () => {
    expect(findBrowserElements(refs, "solicit", undefined, 1)).toHaveLength(1);
    expect(findBrowserElements(refs, "sem correspondência")).toEqual([]);
    expect(findBrowserElements(refs, "solicit", undefined, 20).every((r) =>
      refs.some((source) => source.ref === r.ref))).toBe(true);
  });
});
