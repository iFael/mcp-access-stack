import { createHash } from "node:crypto";
import { describe,expect,it } from "@jest/globals";
import { searchLegacySections, type LegacySource } from "../../../src/memory/legacy-section-index.js";

const doc=(surface:"oracle"|"windows",content:string):LegacySource=>({
  surface,filename:"DECISIONS.md",content,
  contentSha256:createHash("sha256").update(content).digest("hex"),
});
describe("historical .codex section index",()=>{
  it("finds relevant sections across both old surfaces without asserting current truth",()=>{
    const docs=[doc("oracle","# Decisions\n## 100. OAuth\nImplemented in 2026\n## 101. Release\nOracle beta.135 active"),
      doc("windows","# Decisions\n## 100. OAuth\nOld status\n## 101. Release\nOld beta.128 active")];
    const matches=searchLegacySections(docs,"release",5);
    expect(matches).toHaveLength(2);
    expect(matches.map(m=>m.surface)).toEqual(["oracle","windows"]);
    expect(matches[0]).toMatchObject({
      provenance:"historical_unverified",filename:"DECISIONS.md",
      heading:"101. Release",sectionIndex:2,
    });
    expect(matches[0]?.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(matches[0]?.sectionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(searchLegacySections(docs,"beta.135")).toHaveLength(1);
    expect(searchLegacySections(docs,"no such text")).toEqual([]);
  });
  it("rejects corrupted archives and invalid queries",()=>{
    const source=doc("oracle","## A\nsource");
    expect(()=>searchLegacySections([{...source,content:"tampered"}],"source"))
      .toThrow("MEMORY_LEGACY_SOURCE_CORRUPT");
    expect(()=>searchLegacySections([source],"")).toThrow("MEMORY_LEGACY_QUERY_INVALID");
    expect(()=>searchLegacySections([source],"x".repeat(201)))
      .toThrow("MEMORY_LEGACY_QUERY_INVALID");
    expect(()=>searchLegacySections([source],"x",50)).toThrow("MEMORY_LEGACY_QUERY_INVALID");
  });
  it("limits long excerpts and keeps their source section stable",()=>{
    const c="## Detailed\n"+("context ".repeat(2000))+" needle "+("context ".repeat(400));
    const [one]=searchLegacySections([doc("oracle",c)],"needle");
    expect(one).toBeDefined();
    expect(one!.excerpt.length).toBeLessThanOrEqual(702);
    expect(one!.excerpt).toContain("needle");
    expect(one!.provenance).toBe("historical_unverified");
  });
});