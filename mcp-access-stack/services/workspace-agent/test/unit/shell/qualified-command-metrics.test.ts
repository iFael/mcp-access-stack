import { describe, expect, it, jest } from "@jest/globals";
import { QualifiedCommandMetrics } from "../../../src/shell/qualified/qualified-command-metrics.js";

describe("qualified command metrics", () => {
  it("records sanitized aggregate events without command payloads", () => {
    const sink = jest.fn();
    const metrics = new QualifiedCommandMetrics(sink);
    metrics.recordRoute("direct", true);
    metrics.recordShadow({
      status: "qualified",
      durationMs: 3.25,
      source: "explicit-command",
    });
    metrics.recordQualification({
      status: "qualified",
      durationMs: 4.5,
      source: "provider",
    });
    metrics.recordResult({
      status: "executed",
      shell: "cmd",
      cwd: ".",
      exitCode: 0,
      stdout: "secret output",
      stderr: "",
      timedOut: false,
      executionMode: "qualified",
      corrected: true,
      attemptCount: 2,
      diagnosis: {
        category: "syntax",
        confidence: 0.95,
        source: "deterministic",
      },
      correction: {
        applied: true,
        effectiveCommand: "secret command",
        sanitized: true,
      },
      postcondition: { passed: true, checked: 1, failed: 0 },
      attempts: [],
    });

    const serializedEvents = JSON.stringify(sink.mock.calls);
    expect(serializedEvents).not.toContain("secret output");
    expect(serializedEvents).not.toContain("secret command");
    expect(metrics.snapshot()).toMatchObject({
      directCalls: 1,
      shadowCalls: 1,
      shadowQualified: 1,
      qualifications: { total: 1, qualified: 1, p95Ms: 4.5 },
      planSources: { provider: 1 },
      diagnoses: { syntax: 1 },
      corrections: { proposed: 1, applied: 1, blocked: 0 },
      attempts: { one: 0, two: 1 },
      postconditions: { passed: 1, failed: 0 },
    });
  });

  it("never allows a telemetry sink failure to alter behavior", () => {
    const metrics = new QualifiedCommandMetrics(() => {
      throw new Error("sink unavailable");
    });
    expect(() => metrics.recordRoute("qualified", false)).not.toThrow();
    expect(() => metrics.recordError("AGENT_TIMEOUT")).not.toThrow();
    expect(metrics.snapshot()).toMatchObject({
      qualifiedCalls: 1,
      errors: { AGENT_TIMEOUT: 1 },
    });
  });
});
