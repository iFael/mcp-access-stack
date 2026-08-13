import { describe, expect, it } from "@jest/globals";
import { BrowserIdempotencyRegistry } from "../../services/browser-idempotency-registry.js";

describe("BrowserIdempotencyRegistry failure retention", () => {
  it("replays an ambiguous failed outcome without executing the mutation again", async () => {
    const registry = new BrowserIdempotencyRegistry();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      throw new Error("outcome unavailable");
    };

    await expect(registry.run("call-1", "same", operation)).rejects.toThrow(
      "outcome unavailable",
    );
    await expect(registry.run("call-1", "same", operation)).rejects.toThrow(
      "outcome unavailable",
    );

    expect(executions).toBe(1);
    expect(registry.snapshot()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 1,
    });
  });
});
