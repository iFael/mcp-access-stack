import type {
  CommandDiagnosisCategory,
  CommandPlanSource,
  ErrorCode,
  RunCommandResult,
} from "@vs-code-gpt/shared";

const MAX_DURATION_SAMPLES = 2_048;

export type DiagnosisConfidenceBucket = "low" | "medium" | "high";
export type CorrectionBlockReason =
  | "no_safe_repair"
  | "requalification_blocked"
  | "missing_evidence"
  | "safe_reexecution_blocked"
  | "provider_unavailable"
  | "cancelled"
  | "other";

export type QualifiedCommandTelemetryEvent =
  | {
      event: "qualified_command_route";
      mode: "direct" | "qualified";
      shadowEnabled: boolean;
    }
  | {
      event: "qualified_command_qualification";
      status: "qualified" | "blocked" | "error";
      durationMs: number;
      source?: CommandPlanSource;
    }
  | {
      event: "qualified_command_shadow";
      status: "qualified" | "blocked" | "error";
      durationMs: number;
      source?: CommandPlanSource;
    }
  | {
      event: "qualified_command_result";
      status: RunCommandResult["status"];
      attemptCount: number;
      corrected: boolean;
      diagnosis?: CommandDiagnosisCategory;
      diagnosisConfidence?: DiagnosisConfidenceBucket;
      correction: "none" | "applied" | "blocked";
      reexecution: "none" | "allowed" | "blocked";
      correctionBlockReason?: CorrectionBlockReason;
      postconditionPassed?: boolean;
    }
  | {
      event: "qualified_command_error";
      code: ErrorCode;
    };

export interface QualificationMetricInput {
  status: "qualified" | "blocked" | "error";
  durationMs: number;
  source?: CommandPlanSource;
}

export interface QualifiedCommandMetricsSnapshot {
  directCalls: number;
  qualifiedCalls: number;
  shadowCalls: number;
  shadowQualified: number;
  shadowBlocked: number;
  shadowFailures: number;
  qualifications: {
    total: number;
    qualified: number;
    blocked: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  planSources: Partial<Record<CommandPlanSource, number>>;
  diagnoses: Partial<Record<CommandDiagnosisCategory, number>>;
  diagnosisConfidence: Partial<Record<DiagnosisConfidenceBucket, number>>;
  corrections: {
    proposed: number;
    applied: number;
    blocked: number;
    blockReasons: Partial<Record<CorrectionBlockReason, number>>;
  };
  reexecution: {
    allowed: number;
    blocked: number;
  };
  attempts: {
    one: number;
    two: number;
  };
  postconditions: {
    passed: number;
    failed: number;
  };
  errors: Partial<Record<ErrorCode, number>>;
}

export class QualifiedCommandMetrics {
  private directCalls = 0;
  private qualifiedCalls = 0;
  private shadowCalls = 0;
  private shadowQualified = 0;
  private shadowBlocked = 0;
  private shadowFailures = 0;
  private qualificationQualified = 0;
  private qualificationBlocked = 0;
  private qualificationErrors = 0;
  private correctionProposed = 0;
  private correctionApplied = 0;
  private correctionBlocked = 0;
  private reexecutionAllowed = 0;
  private reexecutionBlocked = 0;
  private oneAttempt = 0;
  private twoAttempts = 0;
  private postconditionPassed = 0;
  private postconditionFailed = 0;
  private readonly qualificationDurations: number[] = [];
  private readonly planSources = new Map<CommandPlanSource, number>();
  private readonly diagnoses = new Map<CommandDiagnosisCategory, number>();
  private readonly diagnosisConfidence = new Map<DiagnosisConfidenceBucket, number>();
  private readonly correctionBlockReasons = new Map<CorrectionBlockReason, number>();
  private readonly errors = new Map<ErrorCode, number>();

  constructor(
    private readonly sink?: (event: QualifiedCommandTelemetryEvent) => void,
  ) {}

  recordRoute(mode: "direct" | "qualified", shadowEnabled: boolean): void {
    if (mode === "direct") this.directCalls += 1;
    else this.qualifiedCalls += 1;
    this.emit({ event: "qualified_command_route", mode, shadowEnabled });
  }

  recordQualification(input: QualificationMetricInput): void {
    const durationMs = finiteDuration(input.durationMs);
    appendBounded(this.qualificationDurations, durationMs);
    if (input.status === "qualified") this.qualificationQualified += 1;
    else if (input.status === "blocked") this.qualificationBlocked += 1;
    else this.qualificationErrors += 1;
    if (input.source) increment(this.planSources, input.source);
    this.emit({
      event: "qualified_command_qualification",
      status: input.status,
      durationMs,
      ...(input.source === undefined ? {} : { source: input.source }),
    });
  }

  recordShadow(input: QualificationMetricInput): void {
    const durationMs = finiteDuration(input.durationMs);
    this.shadowCalls += 1;
    if (input.status === "qualified") this.shadowQualified += 1;
    else if (input.status === "blocked") this.shadowBlocked += 1;
    else this.shadowFailures += 1;
    this.emit({
      event: "qualified_command_shadow",
      status: input.status,
      durationMs,
      ...(input.source === undefined ? {} : { source: input.source }),
    });
  }

  recordResult(result: RunCommandResult): void {
    const attemptCount = result.attemptCount ?? 0;
    const corrected = result.corrected ?? false;
    if (attemptCount >= 2) this.twoAttempts += 1;
    else if (attemptCount === 1) this.oneAttempt += 1;

    let diagnosisConfidence: DiagnosisConfidenceBucket | undefined;
    if (result.diagnosis) {
      increment(this.diagnoses, result.diagnosis.category);
      diagnosisConfidence = confidenceBucket(result.diagnosis.confidence);
      increment(this.diagnosisConfidence, diagnosisConfidence);
    }

    let correction: "none" | "applied" | "blocked" = "none";
    let reexecution: "none" | "allowed" | "blocked" = "none";
    let correctionBlockReason: CorrectionBlockReason | undefined;
    if (result.correction) {
      this.correctionProposed += 1;
      if (result.correction.applied) {
        correction = "applied";
        this.correctionApplied += 1;
      } else {
        correction = "blocked";
        this.correctionBlocked += 1;
        correctionBlockReason = blockReasonBucket(
          result.correction.blockedReason,
        );
        increment(this.correctionBlockReasons, correctionBlockReason);
      }
    }
    if (attemptCount >= 2) {
      reexecution = "allowed";
      this.reexecutionAllowed += 1;
    } else if (result.correction && !result.correction.applied) {
      reexecution = "blocked";
      this.reexecutionBlocked += 1;
    }

    if (result.postcondition) {
      if (result.postcondition.passed) this.postconditionPassed += 1;
      else this.postconditionFailed += 1;
    }
    this.emit({
      event: "qualified_command_result",
      status: result.status,
      attemptCount,
      corrected,
      correction,
      reexecution,
      ...(result.diagnosis === undefined
        ? {}
        : { diagnosis: result.diagnosis.category }),
      ...(diagnosisConfidence === undefined
        ? {}
        : { diagnosisConfidence }),
      ...(correctionBlockReason === undefined
        ? {}
        : { correctionBlockReason }),
      ...(result.postcondition === undefined
        ? {}
        : { postconditionPassed: result.postcondition.passed }),
    });
  }

  recordError(code: ErrorCode): void {
    increment(this.errors, code);
    this.emit({ event: "qualified_command_error", code });
  }

  snapshot(): QualifiedCommandMetricsSnapshot {
    const sorted = [...this.qualificationDurations].sort((a, b) => a - b);
    return {
      directCalls: this.directCalls,
      qualifiedCalls: this.qualifiedCalls,
      shadowCalls: this.shadowCalls,
      shadowQualified: this.shadowQualified,
      shadowBlocked: this.shadowBlocked,
      shadowFailures: this.shadowFailures,
      qualifications: {
        total:
          this.qualificationQualified +
          this.qualificationBlocked +
          this.qualificationErrors,
        qualified: this.qualificationQualified,
        blocked: this.qualificationBlocked,
        errors: this.qualificationErrors,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) ?? 0,
      },
      planSources: Object.fromEntries(this.planSources),
      diagnoses: Object.fromEntries(this.diagnoses),
      diagnosisConfidence: Object.fromEntries(this.diagnosisConfidence),
      corrections: {
        proposed: this.correctionProposed,
        applied: this.correctionApplied,
        blocked: this.correctionBlocked,
        blockReasons: Object.fromEntries(this.correctionBlockReasons),
      },
      reexecution: {
        allowed: this.reexecutionAllowed,
        blocked: this.reexecutionBlocked,
      },
      attempts: { one: this.oneAttempt, two: this.twoAttempts },
      postconditions: {
        passed: this.postconditionPassed,
        failed: this.postconditionFailed,
      },
      errors: Object.fromEntries(this.errors),
    };
  }

  private emit(event: QualifiedCommandTelemetryEvent): void {
    try {
      this.sink?.(event);
    } catch {}
  }
}

function appendBounded(values: number[], value: number): void {
  if (values.length >= MAX_DURATION_SAMPLES) values.shift();
  values.push(value);
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000) / 1_000
    : 0;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function confidenceBucket(value: number): DiagnosisConfidenceBucket {
  if (value >= 0.9) return "high";
  if (value >= 0.75) return "medium";
  return "low";
}

function blockReasonBucket(value: string | undefined): CorrectionBlockReason {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("no high-confidence deterministic repair")) {
    return "no_safe_repair";
  }
  if (normalized.includes("requalification")) {
    return "requalification_blocked";
  }
  if (normalized.includes("evidence")) return "missing_evidence";
  if (
    normalized.includes("safe reexecution") ||
    normalized.includes("second attempt") ||
    normalized.includes("effect") ||
    normalized.includes("fingerprint") ||
    normalized.includes("postcondition")
  ) {
    return "safe_reexecution_blocked";
  }
  if (normalized.includes("provider")) return "provider_unavailable";
  if (normalized.includes("cancel")) return "cancelled";
  return "other";
}

function increment<T extends string>(map: Map<T, number>, key: T): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
