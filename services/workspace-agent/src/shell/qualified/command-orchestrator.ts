import { randomUUID } from "node:crypto";
import {
  abortSignalError,
  AppError,
  asAppError,
  createOperationDeadline,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  redactSensitiveText,
  remainingOperationTimeMs,
  type CommandAttempt,
  type CommandCorrection,
  type CommandDiagnosis,
  type CommandInvocationRecord,
  type CommandInvocationResponse,
  type CommandPlan,
  type CommandPostconditionResult,
  type OperationContext,
  type QualifiedRunCommandInput,
  type RunCommandResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../internal-types.js";
import { ShellService, type PreparedQualifiedCommand } from "../service.js";
import { QualifiedCommandPlanQualifier } from "./command-plan-qualifier.js";
import {
  repairProviderInput,
  type RepairProvider,
} from "./command-provider.js";
import {
  hasRequiredRepairEvidence,
  proposeDeterministicRepair,
  proposeProviderRepair,
  type DeterministicRepairProposal,
} from "./deterministic-repair.js";
import {
  CommandInvocationRegistry,
  type CommandInvocationIdentity,
} from "./invocation-registry.js";
import { commandPlanExecutionToRiskCommand } from "./plan-execution.js";
import { validateCommandPostconditions } from "./postcondition-validator.js";
import { classifyQualifiedCommandResult } from "./result-classifier.js";
import { evaluateSafeReexecution } from "./safe-reexecution-gate.js";
import type { QualifiedCommandMetrics } from "./qualified-command-metrics.js";
import type { LimitedCommandContext } from "./types.js";

const ACTIVE_REPLAY_POLL_MS = 50;

type ExecutedResult = Extract<RunCommandResult, { status: "executed" }>;
type ConfirmationResult = Extract<
  RunCommandResult,
  { status: "confirmation_required" }
>;

interface AttemptOutcome {
  result: ExecutedResult;
  postcondition: CommandPostconditionResult;
  diagnosis?: CommandDiagnosis;
  successful: boolean;
  attempt: CommandAttempt;
}

interface PendingRepair {
  originalPlan: CommandPlan;
  correctedPlan: CommandPlan;
  first: AttemptOutcome;
  proposal: DeterministicRepairProposal;
  correction: CommandCorrection;
}

export interface QualifiedCommandOrchestratorOptions {
  registry: CommandInvocationRegistry;
  qualifier?: QualifiedCommandPlanQualifier;
  shellService?: ShellService;
  repairProvider?: RepairProvider;
  metrics?: QualifiedCommandMetrics;
  now?: () => Date;
}

export class QualifiedCommandOrchestrator {
  private readonly qualifier: QualifiedCommandPlanQualifier;
  private readonly shellService: ShellService;
  private readonly now: () => Date;
  private readonly invocationQueues = new Map<string, Promise<void>>();
  private readonly pendingRepairs = new Map<string, PendingRepair>();

  constructor(private readonly options: QualifiedCommandOrchestratorOptions) {
    this.qualifier = options.qualifier ?? new QualifiedCommandPlanQualifier();
    this.shellService = options.shellService ?? new ShellService();
    this.now = options.now ?? (() => new Date());
  }

  async run(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    context: OperationContext = {},
  ): Promise<RunCommandResult> {
    if (input.timeoutMs > MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Qualified commands above 300 seconds are not supported by the synchronous orchestrator.",
      );
    }

    const startedAt = this.timestamp();
    const deadline = createOperationDeadline(
      input.timeoutMs,
      context.deadline,
      startedAt.getTime(),
    );
    if (remainingOperationTimeMs(deadline, startedAt.getTime()) <= 0) {
      throw new AppError("AGENT_TIMEOUT", "Qualified command deadline has expired.");
    }

    const invocationId = context.invocationId ?? randomUUID();
    const qualificationStartedAt = performance.now();
    let qualification;
    try {
      qualification = await this.qualifier.qualify(workspace, {
        invocationId,
        input,
        workspaceId: workspace.id,
        now: startedAt,
        absoluteDeadline: deadline.deadlineAt,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      this.options.metrics?.recordQualification({
        status: qualification.status,
        durationMs: performance.now() - qualificationStartedAt,
        ...(qualification.status === "qualified"
          ? { source: qualification.plan.source }
          : {}),
      });
    } catch (error) {
      this.options.metrics?.recordQualification({
        status: "error",
        durationMs: performance.now() - qualificationStartedAt,
      });
      throw error;
    }
    if (qualification.status === "blocked") {
      throw new AppError(
        "INVALID_ARGUMENT",
        redactSensitiveText(
          qualification.issues[0]?.message ??
            "Qualified command could not be planned deterministically.",
        ),
      );
    }

    const plan = qualification.plan;
    const identity: CommandInvocationIdentity = {
      workspaceId: workspace.id,
      invocationId,
      planFingerprint: plan.fingerprint,
    };
    const queueKey = invocationKey(workspace.id, invocationId);
    return this.serializeInvocation(queueKey, async () => {
      const acquired = await this.options.registry.acquire(identity);
      if (acquired.status === "created") {
        await this.options.registry.transition({
          ...identity,
          expectedState: "received",
          nextState: "qualified",
        });
        return this.continueFromQualified(
          workspace,
          input,
          plan,
          qualification.context,
          identity,
          context,
        );
      }

      return this.resumeExisting(
        workspace,
        input,
        plan,
        qualification.context,
        identity,
        acquired.record,
        context,
      );
    });
  }

  private async resumeExisting(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    plan: CommandPlan,
    initialContext: LimitedCommandContext,
    identity: CommandInvocationIdentity,
    record: CommandInvocationRecord,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    if (record.state === "received") {
      await this.options.registry.transition({
        ...identity,
        expectedState: "received",
        nextState: "qualified",
      });
      return this.continueFromQualified(
        workspace,
        input,
        plan,
        initialContext,
        identity,
        context,
      );
    }
    if (record.state === "qualified") {
      return this.continueFromQualified(
        workspace,
        input,
        plan,
        initialContext,
        identity,
        context,
      );
    }
    if (record.state === "awaiting_confirmation") {
      if (isRepairConfirmation(record.response)) {
        return this.resumeRepairConfirmation(
          workspace,
          input,
          identity,
          record,
          context,
        );
      }
      if (input.confirmationId) {
        return this.continueFromConfirmation(
          workspace,
          input,
          plan,
          initialContext,
          identity,
          context,
        );
      }
      if (isUnexpiredConfirmation(record.response, this.timestamp())) {
        return record.response.value;
      }
      return this.reissueConfirmation(workspace, plan, identity, context);
    }
    if (record.state === "diagnosed" || record.state === "repaired") {
      return this.blockAbandonedRepair(identity, record.state);
    }
    if (record.response) return replayResponse(record.response);

    const response = await this.waitForReplay(identity, plan, context);
    return replayResponse(response);
  }

  private async continueFromQualified(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    plan: CommandPlan,
    initialContext: LimitedCommandContext,
    identity: CommandInvocationIdentity,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    let prepared;
    try {
      prepared = await this.shellService.prepareQualifiedCommand(
        workspace,
        plan,
        input.confirmationId,
        context.signal,
      );
    } catch (error) {
      await this.blockBeforeExecution(identity, "qualified", error);
      throw error;
    }
    if ("status" in prepared) {
      const result = qualifiedConfirmation(prepared);
      await this.options.registry.transition({
        ...identity,
        expectedState: "qualified",
        nextState: "awaiting_confirmation",
        response: resultResponse(result),
      });
      return result;
    }

    await this.options.registry.transition({
      ...identity,
      expectedState: "qualified",
      nextState: "executing",
    });
    return this.executeFirstAttempt(
      workspace,
      input,
      plan,
      initialContext,
      identity,
      prepared,
      context,
    );
  }

  private async continueFromConfirmation(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    plan: CommandPlan,
    initialContext: LimitedCommandContext,
    identity: CommandInvocationIdentity,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    let prepared;
    try {
      prepared = await this.shellService.prepareQualifiedCommand(
        workspace,
        plan,
        input.confirmationId,
        context.signal,
      );
    } catch (error) {
      const appError = asAppError(error);
      if (appError.code === "COMMAND_CONFIRMATION_INVALID") {
        return this.reissueConfirmation(workspace, plan, identity, context);
      }
      await this.blockBeforeExecution(identity, "awaiting_confirmation", appError);
      throw appError;
    }
    if ("status" in prepared) {
      const result = qualifiedConfirmation(prepared);
      await this.options.registry.replaceAwaitingConfirmation(
        identity,
        resultResponse(result),
      );
      return result;
    }

    await this.options.registry.transition({
      ...identity,
      expectedState: "awaiting_confirmation",
      nextState: "executing",
    });
    return this.executeFirstAttempt(
      workspace,
      input,
      plan,
      initialContext,
      identity,
      prepared,
      context,
    );
  }

  private async reissueConfirmation(
    workspace: ResolvedWorkspace,
    plan: CommandPlan,
    identity: CommandInvocationIdentity,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    const prepared = await this.shellService.prepareQualifiedCommand(
      workspace,
      plan,
      undefined,
      context.signal,
    );
    if (!("status" in prepared)) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Persisted confirmation state no longer matches the qualified plan.",
      );
    }
    const result = qualifiedConfirmation(prepared);
    await this.options.registry.replaceAwaitingConfirmation(
      identity,
      resultResponse(result),
    );
    return result;
  }

  private async executeFirstAttempt(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    plan: CommandPlan,
    initialContext: LimitedCommandContext,
    identity: CommandInvocationIdentity,
    prepared: PreparedQualifiedCommand,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    let executionReturned = false;
    try {
      const first = await this.performAttempt(
        workspace,
        plan,
        prepared,
        1,
        context,
        () => {
          executionReturned = true;
        },
      );
      if (
        first.successful ||
        input.autoCorrection !== "safe" ||
        first.diagnosis === undefined
      ) {
        return this.completeFirstAttempt(identity, "executing", first);
      }

      await this.options.registry.transition({
        ...identity,
        expectedState: "executing",
        nextState: "diagnosed",
      });
      return this.repairAfterFirstAttempt(
        workspace,
        input,
        plan,
        initialContext,
        identity,
        first,
        context,
      );
    } catch (error) {
      const appError = asAppError(error);
      if (executionReturned || !provesNoExecution(appError)) {
        await this.markOutcomeUnknown(identity, appError);
      }
      await this.options.registry.transition({
        ...identity,
        expectedState: "executing",
        nextState: "blocked",
        response: errorResponse(appError),
      });
      throw appError;
    }
  }

  private async repairAfterFirstAttempt(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    originalPlan: CommandPlan,
    initialContext: LimitedCommandContext,
    identity: CommandInvocationIdentity,
    first: AttemptOutcome,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    const diagnosis = first.diagnosis;
    if (!diagnosis) {
      return this.completeFirstAttempt(identity, "diagnosed", first);
    }

    let proposal = proposeDeterministicRepair(
      input,
      originalPlan,
      diagnosis,
      initialContext,
    );
    if (
      !proposal &&
      this.options.repairProvider &&
      providerRepairEligible(originalPlan, diagnosis)
    ) {
      const providerInput = repairProviderInput(
        originalPlan,
        diagnosis,
        initialContext,
      );
      if (providerInput) {
        try {
          const providerProposal = await this.options.repairProvider.repair(
            providerInput,
            context.signal,
          );
          proposal = proposeProviderRepair(
            input,
            originalPlan,
            providerProposal,
            initialContext,
          );
        } catch {
          proposal = null;
        }
      }
    }
    if (!proposal) {
      return this.completeFirstAttempt(identity, "diagnosed", first, {
        applied: false,
        sanitized: true,
        blockedReason:
          "No high-confidence deterministic repair exists for this diagnosis.",
      });
    }

    try {
      const correctedQualification = await this.qualifier.qualify(workspace, {
        invocationId: identity.invocationId,
        input: proposal.correctedInput,
        workspaceId: workspace.id,
        now: this.timestamp(),
        absoluteDeadline: originalPlan.absoluteDeadline,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (correctedQualification.status === "blocked") {
        return this.completeFirstAttempt(
          identity,
          "diagnosed",
          first,
          correctionFor(
            proposal,
            undefined,
            false,
            correctedQualification.issues[0]?.message ??
              "The corrected command failed full requalification.",
          ),
        );
      }
      if (!hasRequiredRepairEvidence(proposal, correctedQualification.context)) {
        return this.completeFirstAttempt(
          identity,
          "diagnosed",
          first,
          correctionFor(
            proposal,
            correctedQualification.plan,
            false,
            "The corrected command did not produce the required deterministic workspace evidence.",
          ),
        );
      }

      const gate = evaluateSafeReexecution({
        originalPlan,
        correctedPlan: correctedQualification.plan,
        firstResult: first.result,
        firstPostcondition: first.postcondition,
        diagnosis,
        proposal,
        nowMs: this.timestamp().getTime(),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (!gate.allowed) {
        return this.completeFirstAttempt(
          identity,
          "diagnosed",
          first,
          correctionFor(
            proposal,
            correctedQualification.plan,
            false,
            gate.reason,
          ),
        );
      }

      const correction = correctionFor(
        proposal,
        correctedQualification.plan,
        true,
      );
      const pending: PendingRepair = {
        originalPlan,
        correctedPlan: correctedQualification.plan,
        first,
        proposal,
        correction,
      };
      await this.options.registry.transition({
        ...identity,
        expectedState: "diagnosed",
        nextState: "repaired",
      });
      if (proposal.waitBeforeRetryMs > 0) {
        await delay(proposal.waitBeforeRetryMs, context.signal);
      }

      const prepared = await this.shellService.prepareQualifiedCommand(
        workspace,
        correctedQualification.plan,
        undefined,
        context.signal,
      );
      if ("status" in prepared) {
        this.pendingRepairs.set(invocationKey(workspace.id, identity.invocationId), pending);
        const result = repairConfirmation(prepared, pending);
        await this.options.registry.transition({
          ...identity,
          expectedState: "repaired",
          nextState: "awaiting_confirmation",
          response: resultResponse(result),
        });
        return result;
      }

      await this.options.registry.transition({
        ...identity,
        expectedState: "repaired",
        nextState: "executing",
      });
      return this.executeSecondAttempt(
        workspace,
        identity,
        pending,
        prepared,
        context,
      );
    } catch (error) {
      const appError = asAppError(error);
      if (appError.code === "EXECUTION_OUTCOME_UNKNOWN") throw appError;
      const reason = redactSensitiveText(appError.message);
      return this.completeFirstAttempt(
        identity,
        ["diagnosed", "repaired"],
        first,
        correctionFor(proposal, undefined, false, reason),
      );
    }
  }

  private async resumeRepairConfirmation(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    identity: CommandInvocationIdentity,
    record: CommandInvocationRecord,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    const key = invocationKey(workspace.id, identity.invocationId);
    const pending = this.pendingRepairs.get(key);
    if (!pending) {
      return this.blockAbandonedRepair(identity, "awaiting_confirmation");
    }
    if (input.confirmationId) {
      return this.continueFromRepairConfirmation(
        workspace,
        input,
        identity,
        pending,
        context,
      );
    }
    if (isUnexpiredConfirmation(record.response, this.timestamp())) {
      return record.response.value;
    }
    return this.reissueRepairConfirmation(
      workspace,
      identity,
      pending,
      context,
    );
  }

  private async continueFromRepairConfirmation(
    workspace: ResolvedWorkspace,
    input: QualifiedRunCommandInput,
    identity: CommandInvocationIdentity,
    pending: PendingRepair,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    let prepared;
    try {
      prepared = await this.shellService.prepareQualifiedCommand(
        workspace,
        pending.correctedPlan,
        input.confirmationId,
        context.signal,
      );
    } catch (error) {
      const appError = asAppError(error);
      if (appError.code === "COMMAND_CONFIRMATION_INVALID") {
        return this.reissueRepairConfirmation(
          workspace,
          identity,
          pending,
          context,
        );
      }
      this.pendingRepairs.delete(invocationKey(workspace.id, identity.invocationId));
      await this.options.registry.transition({
        ...identity,
        expectedState: "awaiting_confirmation",
        nextState: "completed",
        response: resultResponse(
          firstAttemptResult(
            pending.first,
            correctionFor(
              pending.proposal,
              pending.correctedPlan,
              false,
              appError.message,
            ),
          ),
        ),
      });
      return firstAttemptResult(
        pending.first,
        correctionFor(
          pending.proposal,
          pending.correctedPlan,
          false,
          appError.message,
        ),
      );
    }
    if ("status" in prepared) {
      const result = repairConfirmation(prepared, pending);
      await this.options.registry.replaceAwaitingConfirmation(
        identity,
        resultResponse(result),
      );
      return result;
    }

    await this.options.registry.transition({
      ...identity,
      expectedState: "awaiting_confirmation",
      nextState: "executing",
    });
    return this.executeSecondAttempt(
      workspace,
      identity,
      pending,
      prepared,
      context,
    );
  }

  private async reissueRepairConfirmation(
    workspace: ResolvedWorkspace,
    identity: CommandInvocationIdentity,
    pending: PendingRepair,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    const prepared = await this.shellService.prepareQualifiedCommand(
      workspace,
      pending.correctedPlan,
      undefined,
      context.signal,
    );
    if (!("status" in prepared)) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Persisted repaired confirmation no longer matches the corrected plan.",
      );
    }
    const result = repairConfirmation(prepared, pending);
    await this.options.registry.replaceAwaitingConfirmation(
      identity,
      resultResponse(result),
    );
    return result;
  }

  private async executeSecondAttempt(
    workspace: ResolvedWorkspace,
    identity: CommandInvocationIdentity,
    pending: PendingRepair,
    prepared: PreparedQualifiedCommand,
    context: OperationContext,
  ): Promise<RunCommandResult> {
    const key = invocationKey(workspace.id, identity.invocationId);
    this.pendingRepairs.set(key, pending);
    let executionReturned = false;
    try {
      const second = await this.performAttempt(
        workspace,
        pending.correctedPlan,
        prepared,
        2,
        context,
        () => {
          executionReturned = true;
        },
      );
      const result: ExecutedResult = {
        ...second.result,
        executionMode: "qualified",
        corrected: true,
        attemptCount: 2,
        ...(second.diagnosis === undefined
          ? {}
          : { diagnosis: second.diagnosis }),
        correction: pending.correction,
        postcondition: second.postcondition,
        attempts: [pending.first.attempt, second.attempt],
      };
      await this.options.registry.transition({
        ...identity,
        expectedState: "executing",
        nextState: "completed",
        response: resultResponse(result),
      });
      this.pendingRepairs.delete(key);
      return result;
    } catch (error) {
      const appError = asAppError(error);
      if (executionReturned || !provesNoExecution(appError)) {
        this.pendingRepairs.delete(key);
        await this.markOutcomeUnknown(identity, appError);
      }
      const correction = correctionFor(
        pending.proposal,
        pending.correctedPlan,
        false,
        appError.message,
      );
      const result = firstAttemptResult(pending.first, correction);
      await this.options.registry.transition({
        ...identity,
        expectedState: "executing",
        nextState: "completed",
        response: resultResponse(result),
      });
      this.pendingRepairs.delete(key);
      return result;
    }
  }

  private async performAttempt(
    workspace: ResolvedWorkspace,
    plan: CommandPlan,
    prepared: PreparedQualifiedCommand,
    attemptNumber: 1 | 2,
    context: OperationContext,
    onExecutionReturned: () => void,
  ): Promise<AttemptOutcome> {
    const startedAt = this.timestamp();
    const raw = await this.shellService.executeQualifiedCommand(
      plan,
      prepared,
      context,
    );
    onExecutionReturned();
    const completedAt = this.timestamp();
    const result: ExecutedResult = {
      ...raw,
      stdout: redactSensitiveText(raw.stdout),
      stderr: redactSensitiveText(raw.stderr),
    };
    const postcondition = await validateCommandPostconditions(
      workspace,
      plan,
      result,
      Math.max(0, completedAt.getTime() - startedAt.getTime()),
      context.signal,
    );
    const classification = classifyQualifiedCommandResult(
      plan,
      result,
      postcondition,
    );
    return {
      result,
      postcondition,
      successful: classification.successful,
      ...(classification.diagnosis === undefined
        ? {}
        : { diagnosis: classification.diagnosis }),
      attempt: {
        attempt: attemptNumber,
        planFingerprint: plan.fingerprint,
        shell: plan.shell,
        cwd: plan.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
    };
  }

  private async completeFirstAttempt(
    identity: CommandInvocationIdentity,
    expectedState:
      | "executing"
      | "diagnosed"
      | "repaired"
      | Array<"diagnosed" | "repaired">,
    first: AttemptOutcome,
    correction?: CommandCorrection,
  ): Promise<RunCommandResult> {
    const result = firstAttemptResult(first, correction);
    await this.options.registry.transition({
      ...identity,
      expectedState,
      nextState: "completed",
      response: resultResponse(result),
    });
    return result;
  }

  private async blockAbandonedRepair(
    identity: CommandInvocationIdentity,
    expectedState: "diagnosed" | "repaired" | "awaiting_confirmation",
  ): Promise<RunCommandResult> {
    const error = new AppError(
      "EXECUTION_STATE_INVALID",
      "A repaired invocation cannot resume after its in-memory correction checkpoint was lost.",
    );
    await this.options.registry.transition({
      ...identity,
      expectedState,
      nextState: "blocked",
      response: errorResponse(error),
    });
    throw error;
  }

  private async markOutcomeUnknown(
    identity: CommandInvocationIdentity,
    error: AppError,
  ): Promise<never> {
    await this.options.registry.transition({
      ...identity,
      expectedState: "executing",
      nextState: "outcome_unknown",
    });
    throw new AppError(
      "EXECUTION_OUTCOME_UNKNOWN",
      "The qualified command may have executed without a durable outcome.",
      error.lifecycle === undefined
        ? { cause: error }
        : { cause: error, lifecycle: error.lifecycle },
    );
  }

  private async blockBeforeExecution(
    identity: CommandInvocationIdentity,
    expectedState: "qualified" | "awaiting_confirmation",
    error: unknown,
  ): Promise<void> {
    const appError = asAppError(error);
    if (appError.code === "COMMAND_CONFIRMATION_INVALID") return;
    await this.options.registry.transition({
      ...identity,
      expectedState,
      nextState: "blocked",
      response: errorResponse(appError),
    });
  }

  private async waitForReplay(
    identity: CommandInvocationIdentity,
    plan: CommandPlan,
    context: OperationContext,
  ): Promise<CommandInvocationResponse> {
    while (true) {
      if (context.signal?.aborted) {
        throw abortSignalError(
          context.signal,
          "Waiting for the active command invocation was cancelled.",
        );
      }
      const record = await this.options.registry.get(identity.invocationId);
      if (!record) {
        throw new AppError(
          "EXECUTION_NOT_FOUND",
          "Active command invocation disappeared before producing a response.",
        );
      }
      if (
        record.workspaceId !== identity.workspaceId ||
        record.planFingerprint !== identity.planFingerprint
      ) {
        throw new AppError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Active command invocation identity changed while waiting for replay.",
        );
      }
      if (record.response) return record.response;

      const remaining = Date.parse(plan.absoluteDeadline) - this.timestamp().getTime();
      if (remaining <= 0) {
        throw new AppError(
          "AGENT_BUSY",
          "An identical qualified command invocation is still active.",
        );
      }
      await delay(Math.min(ACTIVE_REPLAY_POLL_MS, remaining), context.signal);
    }
  }

  private async serializeInvocation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.invocationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.invocationQueues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.invocationQueues.get(key) === current) {
        this.invocationQueues.delete(key);
      }
    }
  }

  private timestamp(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Qualified command orchestrator clock returned an invalid date.",
      );
    }
    return value;
  }
}

function qualifiedConfirmation(result: ConfirmationResult): ConfirmationResult {
  return {
    ...result,
    executionMode: "qualified",
    corrected: false,
  };
}

function providerRepairEligible(
  plan: CommandPlan,
  diagnosis: CommandDiagnosis,
): boolean {
  return (
    (plan.effectClass === "pure_read" ||
      plan.effectClass === "repeatable_local") &&
    [
      "executable_unavailable",
      "wrong_working_directory",
      "argument_incompatible",
      "syntax",
      "quoting",
      "shell_incompatible",
      "resource_locked",
      "transient_failure",
    ].includes(diagnosis.category)
  );
}

function repairConfirmation(
  result: ConfirmationResult,
  pending: PendingRepair,
): ConfirmationResult {
  return {
    ...result,
    executionMode: "qualified",
    corrected: false,
    attemptCount: 1,
    ...(pending.first.diagnosis === undefined
      ? {}
      : { diagnosis: pending.first.diagnosis }),
    correction: {
      ...pending.correction,
      applied: false,
    },
    postcondition: pending.first.postcondition,
    attempts: [pending.first.attempt],
  };
}

function firstAttemptResult(
  first: AttemptOutcome,
  correction?: CommandCorrection,
): ExecutedResult {
  return {
    ...first.result,
    executionMode: "qualified",
    corrected: false,
    attemptCount: 1,
    ...(first.diagnosis === undefined ? {} : { diagnosis: first.diagnosis }),
    ...(correction === undefined ? {} : { correction }),
    postcondition: first.postcondition,
    attempts: [first.attempt],
  };
}

function correctionFor(
  proposal: DeterministicRepairProposal,
  correctedPlan: CommandPlan | undefined,
  applied: boolean,
  blockedReason?: string,
): CommandCorrection {
  const effectiveCommand = redactSensitiveText(
    correctedPlan === undefined
      ? proposal.correctedInput.command ?? proposal.reason
      : commandPlanExecutionToRiskCommand(correctedPlan.execution),
  );
  return {
    applied,
    ...(effectiveCommand.length === 0 ? {} : { effectiveCommand }),
    ...(correctedPlan === undefined
      ? proposal.correctedInput.shell === undefined
        ? {}
        : { effectiveShell: proposal.correctedInput.shell }
      : { effectiveShell: correctedPlan.shell }),
    ...(correctedPlan === undefined
      ? proposal.correctedInput.cwd === undefined
        ? {}
        : { effectiveCwd: proposal.correctedInput.cwd }
      : { effectiveCwd: correctedPlan.cwd }),
    sanitized: true,
    ...(blockedReason === undefined
      ? {}
      : { blockedReason: redactSensitiveText(blockedReason).slice(0, 1_000) }),
  };
}

function resultResponse(result: RunCommandResult): CommandInvocationResponse {
  return {
    kind: "result",
    sanitized: true,
    value: result,
  };
}

function errorResponse(error: AppError): CommandInvocationResponse {
  return {
    kind: "error",
    sanitized: true,
    value: {
      code: error.code,
      message: redactSensitiveText(error.message),
      ...(error.lifecycle === undefined ? {} : { lifecycle: error.lifecycle }),
    },
  };
}

function replayResponse(response: CommandInvocationResponse): RunCommandResult {
  if (response.kind === "result") return response.value;
  throw new AppError(
    response.value.code,
    response.value.message,
    response.value.lifecycle === undefined
      ? undefined
      : { lifecycle: response.value.lifecycle },
  );
}

function isRepairConfirmation(
  response: CommandInvocationResponse | undefined,
): boolean {
  return (
    response?.kind === "result" &&
    response.value.status === "confirmation_required" &&
    response.value.correction !== undefined
  );
}

function isUnexpiredConfirmation(
  response: CommandInvocationResponse | undefined,
  now: Date,
): response is Extract<CommandInvocationResponse, { kind: "result" }> & {
  value: ConfirmationResult;
} {
  return (
    response?.kind === "result" &&
    response.value.status === "confirmation_required" &&
    Date.parse(response.value.expiresAt) > now.getTime()
  );
}

function provesNoExecution(error: AppError): boolean {
  return error.code === "SHELL_UNAVAILABLE" || error.code === "AGENT_TIMEOUT";
}

function invocationKey(workspaceId: string, invocationId: string): string {
  return `${workspaceId}\0${invocationId}`;
}

function delay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void =>
      finish(() => reject(abortSignalError(signal)));
    const timer = setTimeout(() => finish(resolve), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
