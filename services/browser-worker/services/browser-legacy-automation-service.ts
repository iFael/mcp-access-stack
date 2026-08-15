import { randomUUID } from "node:crypto";
import {
  abortSignalError,
  AppError,
  errorCodes,
  type BrowserDomIndexInput,
  type BrowserDomIndexResult,
  type BrowserFrameSequenceInput,
  type BrowserFrameSequenceResult,
  type BrowserNavigatePathInput,
  type BrowserNavigatePathResult,
  type BrowserProfilePageInput,
  type BrowserProfilePageResult,
  type ErrorCode,
  type LegacyFrameNode,
  type LegacyFrameSequenceStep,
  type LegacyPageProfile,
  type LegacyTelemetry,
} from "@vs-code-gpt/shared";
import type { Frame, Page } from "playwright";
import type { BrowserDriverResponse } from "../drivers/browser-driver.js";
import { BrowserPageStabilizationService } from "./browser-page-stabilization-service.js";
import type {
  BrowserDriverCallOptions,
  BrowserPressRequest,
} from "../drivers/browser-driver.js";

type WithoutTabId<T extends { tabId: string }> = Omit<T, "tabId">;

interface LegacyExecution<T> {
  result: T;
  response: BrowserDriverResponse;
}

interface LegacyNavigationCacheEntry {
  pageSignature: string;
  frameGraphSignature: string;
  selectors: string[];
}

interface LegacyEvaluationEnvelope<T> {
  ok: true;
  result: T;
}

interface LegacyEvaluationErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

interface LegacyNativePressFocusResult {
  ref?: string | undefined;
  strategy: string;
  telemetry: LegacyTelemetry;
}

export interface BrowserLegacyAutomationDriver {
  activePage(): Page;
  resolveFramePath(framePath: readonly string[]): Promise<Frame>;
  currentPageResponse(content?: string): Promise<BrowserDriverResponse>;
  press(
    input: BrowserPressRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
}

export interface BrowserLegacyAutomationServiceOptions {
  driver: BrowserLegacyAutomationDriver;
}

export class BrowserLegacyAutomationService {
  private readonly navigationCache = new Map<string, LegacyNavigationCacheEntry>();

  constructor(private readonly options: BrowserLegacyAutomationServiceOptions) {}

  profilePage(
    input: BrowserProfilePageInput,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserProfilePageResult>>> {
    return this.execute("profilePage", {
      maxDepth: input.maxDepth ?? 8,
    }, signal);
  }

  domIndex(
    input: BrowserDomIndexInput,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserDomIndexResult>>> {
    return this.execute("domIndex", {
      framePath: input.framePath ?? [],
      rootSelector: input.rootSelector,
      query: input.query,
      offset: input.offset ?? 0,
      limit: input.limit ?? 500,
      visibleOnly: input.visibleOnly ?? false,
    }, signal);
  }

  async frameSequence(
    input: BrowserFrameSequenceInput,
    authorizedStepIndexes: ReadonlySet<number> = new Set(),
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserFrameSequenceResult>>> {
    const nativePressSteps = input.steps.filter(
      (step) => step.action === "press" && step.mode === "native",
    );
    if (nativePressSteps.length > 0) {
      if (input.steps.length !== 1 || nativePressSteps.length !== 1) {
        throw new AppError(
          "CAPABILITY_UNSUPPORTED",
          "A native legacy press must be the only step in browser_frame_sequence.",
        );
      }
      const step = nativePressSteps[0];
      if (!step || step.action !== "press") {
        throw new AppError("INTERNAL_ERROR", "Native legacy press resolution failed.");
      }
      return this.executeNativePress(
        step,
        authorizedStepIndexes.has(0),
        input.timeoutMs ?? 60_000,
        signal,
      );
    }
    return this.execute("frameSequence", {
      steps: input.steps.map((step, index) => ({
        ...step,
        authorized: authorizedStepIndexes.has(index),
      })),
      timeoutMs: input.timeoutMs ?? 60_000,
    }, signal);
  }

  async navigatePath(
    input: BrowserNavigatePathInput,
    authorized: boolean,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserNavigatePathResult>>> {
    const startedAt = performance.now();
    if (input.segments && input.segments.length > 0) {
      const execution = await this.navigateSegmentedPath(
        input,
        authorized,
        signal,
      );
      return this.withNavigationCheckpoint(input, execution, startedAt, signal);
    }
    const cacheKey = JSON.stringify({
      path: input.path,
      sourceFramePath: input.sourceFramePath ?? [],
      targetFramePath: input.targetFramePath ?? [],
      segments: [],
    });
    const execution = await this.execute<
      WithoutTabId<BrowserNavigatePathResult> & {
        cacheEntry?: LegacyNavigationCacheEntry;
      }
    >("navigatePath", {
      path: input.path,
      sourceFramePath: input.sourceFramePath ?? [],
      targetFramePath: input.targetFramePath ?? [],
      segments: [],
      timeoutMs: input.timeoutMs ?? 60_000,
      authorized,
      cached: this.navigationCache.get(cacheKey),
    }, signal);
    const { cacheEntry, ...result } = execution.result;
    if (cacheEntry) this.navigationCache.set(cacheKey, cacheEntry);
    return this.withNavigationCheckpoint(
      input,
      { result, response: execution.response },
      startedAt,
      signal,
    );
  }

  private async withNavigationCheckpoint(
    input: BrowserNavigatePathInput,
    execution: LegacyExecution<WithoutTabId<BrowserNavigatePathResult>>,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserNavigatePathResult>>> {
    if (!input.checkpoint) return execution;
    const remainingMs = Math.max(
      1,
      (input.timeoutMs ?? 60_000) - (performance.now() - startedAt),
    );
    const checkpoint = await this.frameSequence(
      {
        tabId: input.tabId,
        steps: [input.checkpoint],
        timeoutMs: remainingMs,
      },
      new Set(),
      signal,
    );
    const step = checkpoint.result.steps[0];
    if (!step) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "Legacy navigation checkpoint returned no step result.",
      );
    }
    return {
      response: checkpoint.response,
      result: {
        ...execution.result,
        checkpoint: {
          step,
          telemetry: checkpoint.result.telemetry,
        },
        telemetry: mergeNavigationTelemetry(
          execution.result.telemetry,
          checkpoint.result.telemetry,
          performance.now() - startedAt,
        ),
      },
    };
  }

  private async navigateSegmentedPath(
    input: BrowserNavigatePathInput,
    authorized: boolean,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserNavigatePathResult>>> {
    const segments = input.segments ?? [];
    const startedAt = performance.now();
    const deadline = Date.now() + (input.timeoutMs ?? 60_000);
    const resolved: BrowserNavigatePathResult["resolved"] = [];
    const segmentResults: NonNullable<BrowserNavigatePathResult["segments"]> = [];
    let response: BrowserDriverResponse | undefined;
    let globalLevel = 0;
    let frameResolutionMs = 0;
    let locatorMs = 0;
    let interactionMs = 0;
    let navigationMs = 0;
    let candidateCount = 0;
    let cacheHit = true;
    let cacheInvalidated = false;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (signal?.aborted) {
        throw abortSignalError(signal, "Legacy browser operation was cancelled.");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new AppError("NAVIGATION_TIMEOUT", "Legacy navigation path exceeded its deadline.");
      }
      const segment = segments[segmentIndex]!;
      const cacheKey = JSON.stringify({
        path: segment.path,
        sourceFramePath: segment.framePath,
        rootSelector: segment.rootSelector,
      });
      const execution = await this.execute<
        WithoutTabId<BrowserNavigatePathResult> & {
          cacheEntry?: LegacyNavigationCacheEntry;
        }
      >("navigatePath", {
        path: segment.path,
        sourceFramePath: segment.framePath,
        targetFramePath: [],
        rootSelector: segment.rootSelector,
        segments: [],
        timeoutMs: remainingMs,
        authorized,
        cached: this.navigationCache.get(cacheKey),
      }, signal);
      response = execution.response;
      const { cacheEntry, ...segmentResult } = execution.result;
      if (cacheEntry) this.navigationCache.set(cacheKey, cacheEntry);
      cacheHit = cacheHit && segmentResult.cache.hit;
      cacheInvalidated = cacheInvalidated || segmentResult.cache.invalidated;
      frameResolutionMs += segmentResult.telemetry.frameResolutionMs ?? 0;
      locatorMs += segmentResult.telemetry.locatorMs ?? 0;
      interactionMs += segmentResult.telemetry.interactionMs ?? 0;
      candidateCount += segmentResult.telemetry.candidateCount ?? 0;
      for (const level of segmentResult.resolved) {
        resolved.push({
          ...level,
          level: globalLevel,
          segment: segmentIndex,
          framePath: segment.framePath,
        });
        globalLevel += 1;
      }

      let segmentNavigationMs = 0;
      const nextSegment = segments[segmentIndex + 1];
      const waitFramePath = segment.waitFor?.framePath
        ?? (segment.targetFramePath && segment.targetFramePath.length > 0
          ? segment.targetFramePath
          : nextSegment?.framePath);
      const implicitNextLabel = nextSegment?.path[0];
      const hasTargetFrame = Boolean(segment.targetFramePath && segment.targetFramePath.length > 0);
      if (segment.waitFor || (waitFramePath && (implicitNextLabel || hasTargetFrame))) {
        await waitForDriverCheckpoint(signal);
        const waitRemainingMs = deadline - Date.now();
        if (waitRemainingMs <= 0) {
          throw new AppError("NAVIGATION_TIMEOUT", "Legacy navigation path exceeded its deadline.");
        }
        const waitStep: LegacyFrameSequenceStep = segment.waitFor
          ? {
              action: "waitFor",
              framePath: waitFramePath ?? segment.framePath,
              ...(segment.waitFor.locator === undefined ? {} : { locator: segment.waitFor.locator }),
              ...(segment.waitFor.text === undefined ? {} : { text: segment.waitFor.text }),
              ...(segment.waitFor.state === undefined ? {} : { state: segment.waitFor.state }),
              timeoutMs: Math.min(segment.waitFor.timeoutMs ?? 10_000, waitRemainingMs),
            }
          : implicitNextLabel
            ? {
                action: "waitFor",
                framePath: waitFramePath ?? segment.framePath,
                text: implicitNextLabel,
                timeoutMs: Math.min(10_000, waitRemainingMs),
              }
            : {
                action: "waitFor",
                framePath: waitFramePath ?? segment.framePath,
                state: "ready",
                timeoutMs: Math.min(10_000, waitRemainingMs),
              };
        const waitStartedAt = performance.now();
        const waitExecution = await this.execute<WithoutTabId<BrowserFrameSequenceResult>>(
          "frameSequence",
          { steps: [{ ...waitStep, authorized: false }], timeoutMs: waitRemainingMs },
          signal,
        );
        response = waitExecution.response;
        segmentNavigationMs = Math.max(
          waitExecution.result.telemetry.navigationMs ?? 0,
          performance.now() - waitStartedAt,
        );
        navigationMs += segmentNavigationMs;
      }

      const segmentTelemetry: LegacyTelemetry = {
        ...segmentResult.telemetry,
        totalMs: segmentResult.telemetry.totalMs + segmentNavigationMs,
        navigationMs: (segmentResult.telemetry.navigationMs ?? 0) + segmentNavigationMs,
      };
      segmentResults.push({
        index: segmentIndex,
        framePath: segment.framePath,
        path: segment.path,
        ...(segment.targetFramePath === undefined ? {} : { targetFramePath: segment.targetFramePath }),
        destinationReady: true,
        telemetry: segmentTelemetry,
      });
    }

    if (!response) {
      throw new AppError("INTERNAL_ERROR", "Segmented legacy navigation did not execute any segment.");
    }
    const totalMs = Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
    return {
      response,
      result: {
        completed: true,
        path: input.path,
        resolved,
        destinationReady: true,
        segments: segmentResults,
        cache: {
          hit: cacheHit,
          revalidated: cacheHit,
          invalidated: cacheInvalidated,
        },
        telemetry: {
          totalMs,
          frameResolutionMs,
          locatorMs,
          interactionMs,
          navigationMs,
          candidateCount,
          cacheHit,
          cacheInvalidated,
          strategy: cacheHit ? "cache-revalidated" : "deterministic-locator",
          retries: 0,
        },
      },
    };
  }

  private async executeNativePress(
    step: Extract<LegacyFrameSequenceStep, { action: "press" }>,
    authorized: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserFrameSequenceResult>>> {
    const startedAt = performance.now();
    const focus = await this.execute<LegacyNativePressFocusResult>(
      "focusForNativePress",
      { step: { ...step, authorized } },
      signal,
    );
    const response = await this.options.driver.press(
      { key: step.key },
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
      },
    );
    const totalMs = Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
    return {
      response,
      result: {
        completed: true,
        steps: [{
          index: 0,
          action: "press",
          completed: true,
          ...(focus.result.ref === undefined ? {} : { ref: focus.result.ref }),
          strategy: "native-" + focus.result.strategy,
        }],
        telemetry: {
          ...focus.result.telemetry,
          totalMs,
          interactionMs: Math.max(
            focus.result.telemetry.interactionMs ?? 0,
            totalMs - focus.result.telemetry.totalMs,
          ),
          strategy: "native-keyboard",
        },
      },
    };
  }

  private execute<T>(
    operation: "profilePage" | "domIndex" | "frameSequence" | "navigatePath" | "focusForNativePress",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<T>> {
    return this.executeDirect<T>(operation, input, signal);
  }

  private async executeDirect<T>(
    operation: "profilePage" | "domIndex" | "frameSequence" | "navigatePath" | "focusForNativePress",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<T>> {
    const driver = this.options.driver;
    if (operation === "profilePage") {
      return this.profileDirect(
        driver,
        input as { maxDepth?: number },
        signal,
      ) as Promise<LegacyExecution<T>>;
    }
    if (operation === "domIndex") {
      return this.domIndexDirect(
        driver,
        input as Record<string, unknown>,
        signal,
      ) as Promise<LegacyExecution<T>>;
    }
    if (operation === "frameSequence") {
      return this.frameSequenceDirect(
        driver,
        input as {
          steps: Array<LegacyFrameSequenceStep & { authorized?: boolean }>;
          timeoutMs?: number;
        },
        signal,
      ) as Promise<LegacyExecution<T>>;
    }
    if (operation === "navigatePath") {
      return this.navigatePathDirect(
        driver,
        input as Record<string, unknown>,
        signal,
      ) as Promise<LegacyExecution<T>>;
    }
    const record = input as {
      step?: LegacyFrameSequenceStep & { authorized?: boolean };
    };
    const framePath = record.step?.framePath ?? [];
    return this.evaluateDirect<T>(
      driver,
      operation,
      {
        ...record,
        step: record.step ? { ...record.step, framePath: [] } : undefined,
      },
      framePath,
      signal,
    );
  }

  private async profileDirect(
    driver: BrowserLegacyAutomationDriver,
    input: { maxDepth?: number },
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserProfilePageResult>>> {
    const startedAt = performance.now();
    assertDirectSignal(signal);
    const result = await collectDirectPageProfile(
      driver.activePage().mainFrame(),
      input.maxDepth ?? 8,
      signal,
    );
    return {
      result: {
        ...result,
        telemetry: {
          totalMs: directElapsedMs(startedAt),
          frameResolutionMs: directElapsedMs(startedAt),
          retries: 0,
        },
      },
      response: await driver.currentPageResponse(),
    };
  }

  private async domIndexDirect(
    driver: BrowserLegacyAutomationDriver,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserDomIndexResult>>> {
    const framePath = directFramePath(input.framePath);
    const execution = await this.evaluateDirect<
      WithoutTabId<BrowserDomIndexResult>
    >(
      driver,
      "domIndex",
      { ...input, framePath: [] },
      framePath,
      signal,
    );
    return {
      response: execution.response,
      result: {
        ...execution.result,
        framePath,
        items: execution.result.items.map((item) => ({ ...item, framePath })),
      },
    };
  }

  private async frameSequenceDirect(
    driver: BrowserLegacyAutomationDriver,
    input: {
      steps: Array<LegacyFrameSequenceStep & { authorized?: boolean }>;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<LegacyExecution<WithoutTabId<BrowserFrameSequenceResult>>> {
    const startedAt = performance.now();
    const deadline = Date.now() + Math.max(1, input.timeoutMs ?? 60_000);

    // Validate every potentially mutating target before the first action so a
    // later confirmation failure can never leave a partially executed batch.
    const navigationLikelySteps = new Set<number>();
    const navigationTargets = new Map<number, string>();
    const isolatedSteps = new Set<number>();
    for (const [index, step] of input.steps.entries()) {
      const isEnter = step.action === "press" &&
        normalizeDirectText(step.key) === "enter";
      if (step.action !== "click" && !isEnter) continue;
      isolatedSteps.add(index);
      const framePath = step.framePath ?? [];
      const preflight = await this.evaluateDirect<{
        navigationLikely: boolean;
        navigationTarget?: string;
      }>(
        driver,
        "preflightFrameStep",
        { step: { ...step, framePath: [] } },
        framePath,
        signal,
      );
      if (preflight.result.navigationLikely) {
        navigationLikelySteps.add(index);
        if (preflight.result.navigationTarget) {
          navigationTargets.set(index, preflight.result.navigationTarget);
        }
      }
    }

    const batches: Array<{
      entries: Array<{
        index: number;
        step: LegacyFrameSequenceStep & { authorized?: boolean };
      }>;
      framePath: readonly string[];
      navigationLikely: boolean;
      navigationTarget?: string;
    }> = [];
    for (const [index, step] of input.steps.entries()) {
      const framePath = step.framePath ?? [];
      const isolated = isolatedSteps.has(index);
      const previous = batches.at(-1);
      const sameFrame = previous !== undefined &&
        previous.framePath.length === framePath.length &&
        previous.framePath.every((segment, offset) => segment === framePath[offset]);
      if (
        !isolated &&
        previous !== undefined &&
        !previous.navigationLikely &&
        !isolatedSteps.has(previous.entries.at(-1)?.index ?? -1) &&
        sameFrame
      ) {
        previous.entries.push({ index, step });
        continue;
      }
      batches.push({
        entries: [{ index, step }],
        framePath,
        navigationLikely: navigationLikelySteps.has(index),
        ...(navigationTargets.has(index)
          ? { navigationTarget: navigationTargets.get(index)! }
          : {}),
      });
    }

    const steps: BrowserFrameSequenceResult["steps"] = [];
    let response: BrowserDriverResponse | undefined;
    const totals: Record<
      | "frameResolutionMs"
      | "indexMs"
      | "locatorMs"
      | "interactionMs"
      | "navigationMs"
      | "candidateCount",
      number
    > = {
      frameResolutionMs: 0,
      indexMs: 0,
      locatorMs: 0,
      interactionMs: 0,
      navigationMs: 0,
      candidateCount: 0,
    };
    let strategy: string | undefined;
    let retries = 0;

    for (const batch of batches) {
      assertDirectSignal(signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new AppError(
          "NAVIGATION_TIMEOUT",
          "Legacy sequence exceeded its deadline.",
        );
      }
      const navigationFramePath = batch.navigationLikely
        ? await resolveDirectNavigationTargetFramePath(
            driver,
            batch.framePath,
            batch.navigationTarget,
          )
        : batch.framePath;
      const navigation = batch.navigationLikely
        ? await beginDirectFrameNavigationWait(
            driver,
            navigationFramePath,
            remainingMs,
          )
        : undefined;
      let execution!: LegacyExecution<WithoutTabId<BrowserFrameSequenceResult>>;
      const waitForFrameBatch = batch.entries.every(({ step }) => step.action === "waitFor");
      const firstWaitTimeoutMs = waitForFrameBatch
        ? batch.entries.reduce((minimum, { step }) =>
            Math.min(
              minimum,
              step.action === "waitFor" ? step.timeoutMs ?? 10_000 : minimum,
            ), remainingMs)
        : 0;
      const frameWaitDeadline = waitForFrameBatch
        ? Math.min(deadline, Date.now() + firstWaitTimeoutMs)
        : Date.now();
      for (let attempt = 0; ; attempt += 1) {
        try {
          execution = await this.evaluateDirect<
            WithoutTabId<BrowserFrameSequenceResult>
          >(
            driver,
            "frameSequence",
            {
              steps: batch.entries.map(({ step }) => ({
                ...step,
                framePath: [],
                deferNavigation: batch.navigationLikely,
              })),
              timeoutMs: Math.max(1, deadline - Date.now()),
            },
            batch.framePath,
            signal,
          );
          break;
        } catch (error) {
          const readOnlyBatch = batch.entries.every(({ step }) =>
            ["waitFor", "assert", "extract", "index"].includes(step.action)
          );
          const retryMissingWaitFrame =
            waitForFrameBatch &&
            isRetryableDirectFrameResolutionError(error);
          if (retryMissingWaitFrame && Date.now() >= frameWaitDeadline) {
            const completedIndexes = steps.map((step) => step.index);
            const observedIndexes = batch.entries.map((entry) => entry.index);
            const progress = completedIndexes.length > 0
              ? ` after completed step indexes [${completedIndexes.join(",")}] while observing step indexes [${observedIndexes.join(",")}]`
              : "";
            throw new AppError(
              "STATE_NOT_REACHED",
              `Legacy frame state was not reached before the deadline${progress}.`,
              { cause: error },
            );
          }
          const retryTransientRead =
            attempt < 1 &&
            readOnlyBatch &&
            isTransientDirectFrameContextError(error);
          if (!retryMissingWaitFrame && !retryTransientRead) {
            if (error instanceof AppError && steps.length > 0) {
              const completedIndexes = steps.map((step) => step.index);
              const observedIndexes = batch.entries.map((entry) => entry.index);
              throw new AppError(
                error.code,
                `Legacy frame sequence failed while observing step indexes [${observedIndexes.join(",")}] after completed step indexes [${completedIndexes.join(",")}]. ${error.message}`,
                { cause: error },
              );
            }
            throw error;
          }
          retries += 1;
          await directDelay(25, signal);
        }
      }
      try {
        await navigation?.();
      } catch (error) {
        if (error instanceof AppError) {
          const completedIndexes = [
            ...steps.map((step) => step.index),
            ...batch.entries.map((entry) => entry.index),
          ];
          throw new AppError(
            error.code,
            `Legacy frame sequence reached post-action observation after step indexes [${completedIndexes.join(",")}]. ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }
      response = execution.response;
      if (execution.result.steps.length !== batch.entries.length) {
        throw new AppError(
          "RELAY_PROTOCOL_ERROR",
          "Direct legacy sequence returned an unexpected step count.",
        );
      }
      for (const [localIndex, entry] of batch.entries.entries()) {
        const item = execution.result.steps[localIndex];
        if (!item) {
          throw new AppError(
            "RELAY_PROTOCOL_ERROR",
            "Direct legacy sequence returned no step result.",
          );
        }
        steps.push({
          ...item,
          index: entry.index,
          ...(item.value && typeof item.value === "object"
            ? { value: normalizeDirectIndexValue(item.value, batch.framePath) }
            : {}),
        });
      }
      accumulateLegacyTelemetry(totals, execution.result.telemetry);
      strategy = execution.result.telemetry.strategy ?? strategy;
    }
    if (!response) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Direct legacy sequence did not execute any step.",
      );
    }
    return {
      response,
      result: {
        completed: true,
        steps,
        telemetry: {
          totalMs: directElapsedMs(startedAt),
          ...totals,
          ...(strategy ? { strategy } : {}),
          retries,
        },
      },
    };
  }

  private async navigatePathDirect(
    driver: BrowserLegacyAutomationDriver,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LegacyExecution<
    WithoutTabId<BrowserNavigatePathResult> & {
      cacheEntry?: LegacyNavigationCacheEntry;
    }
  >> {
    const timeoutMs = typeof input.timeoutMs === "number"
      ? input.timeoutMs
      : 60_000;
    const navigationDeadline = Date.now() + Math.max(1, timeoutMs);
    const sourceFramePath = directFramePath(input.sourceFramePath);
    const targetFramePath = directFramePath(input.targetFramePath);
    const initialTarget = targetFramePath.length > 0
      ? await directFrameDocumentState(
          await driver.resolveFramePath(targetFramePath),
        )
      : undefined;
    const execution = await this.evaluateDirect<
      WithoutTabId<BrowserNavigatePathResult> & {
        cacheEntry?: LegacyNavigationCacheEntry;
      }
    >(
      driver,
      "navigatePath",
      {
        ...input,
        timeoutMs: Math.max(1, navigationDeadline - Date.now()),
        sourceFramePath: [],
        targetFramePath: [],
      },
      sourceFramePath,
      signal,
    );
    if (!initialTarget) return execution;

    const navigationStartedAt = performance.now();
    if (Date.now() >= navigationDeadline) {
      throw new AppError(
        "NAVIGATION_TIMEOUT",
        "Legacy navigation path exceeded its deadline before destination stabilization.",
      );
    }
    const stabilization = new BrowserPageStabilizationService({
      probe: async () => {
        while (true) {
          assertDirectSignal(signal);
          try {
            const frame = await driver.resolveFramePath(targetFramePath);
            const current = await directFrameDocumentState(frame);
            return {
              readyState: normalizeDirectReadyState(current.readyState),
              signature: current.signature,
              navigationEpoch: current.signature === initialTarget.signature ? 0 : 1,
              frameCount: frame.childFrames().length,
              unreadyFrames: 0,
              pendingRelevantRequests: 0,
            };
          } catch (error) {
            if (
              !isRetryableDirectFrameResolutionError(error) &&
              !isTransientDirectFrameContextError(error)
            ) {
              throw error;
            }
            if (Date.now() >= navigationDeadline) {
              throw new AppError(
                "STATE_NOT_REACHED",
                "Legacy destination frame did not settle before the deadline.",
                { cause: error },
              );
            }
            await directDelay(
              Math.min(25, Math.max(1, navigationDeadline - Date.now())),
              signal,
            );
          }
        }
      },
      pollIntervalMs: 50,
      quietWindowMs: 300,
      minimumObservationMs: 450,
      busyGraceMs: 750,
    });
    const stabilized = await stabilization.stabilize({
      timeoutMs: Math.max(1, navigationDeadline - Date.now()),
      ...(signal ? { signal } : {}),
    });
    if (stabilized.status !== "stable") {
      throw new AppError(
        "STATE_NOT_REACHED",
        "Legacy destination frame remained mutable until the navigation deadline.",
      );
    }
    let finalTarget: DirectFrameDocumentState;
    while (true) {
      assertDirectSignal(signal);
      try {
        const finalFrame = await driver.resolveFramePath(targetFramePath);
        finalTarget = await directFrameDocumentState(finalFrame);
        break;
      } catch (error) {
        if (
          !isRetryableDirectFrameResolutionError(error) &&
          !isTransientDirectFrameContextError(error)
        ) {
          throw error;
        }
        if (Date.now() >= navigationDeadline) {
          throw new AppError(
            "STATE_NOT_REACHED",
            "Legacy destination frame did not settle before the deadline.",
            { cause: error },
          );
        }
        await directDelay(
          Math.min(25, Math.max(1, navigationDeadline - Date.now())),
          signal,
        );
      }
    }
    if (
      finalTarget.readyState === "loading" ||
      finalTarget.signature === initialTarget.signature
    ) {
      throw new AppError(
        "STATE_NOT_REACHED",
        "Legacy destination frame did not reach a stable replacement document before the deadline.",
      );
    }
    const navigationMs = directElapsedMs(navigationStartedAt);
    return {
      response: await driver.currentPageResponse(),
      result: {
        ...execution.result,
        destinationReady: true,
        telemetry: {
          ...execution.result.telemetry,
          totalMs: execution.result.telemetry.totalMs + navigationMs,
          navigationMs:
            (execution.result.telemetry.navigationMs ?? 0) + navigationMs,
        },
      },
    };
  }

  private async evaluateDirect<T>(
    driver: BrowserLegacyAutomationDriver,
    operation:
      | "domIndex"
      | "frameSequence"
      | "navigatePath"
      | "focusForNativePress"
      | "preflightFrameStep",
    input: unknown,
    framePath: readonly string[],
    signal?: AbortSignal,
  ): Promise<LegacyExecution<T>> {
    assertDirectSignal(signal);
    const frame = await driver.resolveFramePath(framePath);
    const evaluationId = randomUUID();
    const cancel = (): void => {
      void cancelDirectEvaluation(frame, evaluationId);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const value = await evaluateDirectFunction(
        frame,
        buildLegacyEvaluationFunction(operation, input, evaluationId),
      );
      const envelope = parseEnvelope<T>(value);
      if (!envelope.ok) {
        throw new AppError(
          normalizeLegacyErrorCode(envelope.error.code),
          envelope.error.message,
        );
      }
      assertDirectSignal(signal);
      return {
        result: envelope.result,
        response: await driver.currentPageResponse(),
      };
    } catch (error) {
      if (signal?.aborted) {
        cancel();
        throw abortSignalError(
          signal,
          "Legacy browser operation was cancelled.",
        );
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}

async function resolveDirectNavigationTargetFramePath(
  driver: BrowserLegacyAutomationDriver,
  sourceFramePath: readonly string[],
  target: string | undefined,
): Promise<readonly string[]> {
  const normalized = target?.trim();
  if (!normalized || normalized.toLowerCase() === "_self") return sourceFramePath;
  if (normalized.toLowerCase() === "_top") return [];
  if (normalized.toLowerCase() === "_parent") return sourceFramePath.slice(0, -1);
  if (normalized.toLowerCase() === "_blank") {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Legacy frame sequence cannot wait deterministically for target=_blank navigation.",
    );
  }
  const path = await findDirectNamedFramePath(
    driver.activePage().mainFrame(),
    normalized,
    [],
  );
  if (!path) {
    throw new AppError(
      "FRAME_NOT_FOUND",
      "Legacy navigation target frame was not found: " + normalized,
    );
  }
  return path;
}

async function findDirectNamedFramePath(
  frame: Frame,
  target: string,
  parentPath: readonly string[],
): Promise<string[] | undefined> {
  for (const [index, child] of frame.childFrames().entries()) {
    const element = await child.frameElement().catch(() => undefined);
    const [name, id] = element
      ? await Promise.all([
          element.getAttribute("name").catch(() => null),
          element.getAttribute("id").catch(() => null),
        ])
      : [null, null];
    const childName = child.name() || name || "";
    const segment = childName || id || String(index);
    const childPath = [...parentPath, segment];
    if (childName === target || id === target) return childPath;
    const nested = await findDirectNamedFramePath(child, target, childPath);
    if (nested) return nested;
  }
  return undefined;
}

async function beginDirectFrameNavigationWait(
  driver: BrowserLegacyAutomationDriver,
  framePath: readonly string[],
  timeoutMs: number,
): Promise<() => Promise<"navigated" | "not-started">> {
  const frame = await driver.resolveFramePath(framePath);
  const navigationStartTimeoutMs = Math.max(1, Math.min(timeoutMs, 500));
  const committed = frame.waitForNavigation({
    waitUntil: "commit",
    timeout: navigationStartTimeoutMs,
  }).then(
    () => ({ status: "committed" as const }),
    (error: unknown) =>
      error instanceof Error && error.name === "TimeoutError"
        ? ({ status: "not-started" as const })
        : ({ status: "failed" as const, error }),
  );
  return async () => {
    const result = await committed;
    if (result.status === "not-started") return "not-started";
    if (result.status === "failed") {
      throw new AppError(
        "STATE_NOT_REACHED",
        "Legacy frame navigation observation failed before document commit; the action dispatch may already have occurred.",
        { cause: result.error },
      );
    }
    try {
      await frame.waitForLoadState("domcontentloaded", {
        timeout: Math.max(1, timeoutMs - navigationStartTimeoutMs),
      });
    } catch (error) {
      throw new AppError(
        "STATE_NOT_REACHED",
        "Legacy frame action was dispatched and navigation committed, but the replacement document did not reach DOMContentLoaded.",
        { cause: error },
      );
    }
    return "navigated";
  };
}
interface DirectDocumentSignals {
  layoutTables: number;
  inlineHandlers: number;
  hashLinks: number;
  targetedNavigation: number;
  postForms: number;
  origin: string;
  pathname: string;
  title: string;
  childElementCount: number;
}

interface DirectFrameDocumentState {
  readyState: string;
  signature: string;
}

async function collectDirectPageProfile(
  mainFrame: Frame,
  maxDepth: number,
  signal?: AbortSignal,
): Promise<Omit<
  WithoutTabId<BrowserProfilePageResult>,
  "telemetry"
>> {
  const frames: LegacyFrameNode[] = [];
  for (const [index, frame] of mainFrame.childFrames().slice(0, 100).entries()) {
    frames.push(
      await inspectDirectFrame(frame, index, [], 0, maxDepth, signal),
    );
  }
  const flattened = flattenDirectFrames(frames);
  const aggregate = {
    frames: flattened.length,
    nestedFrames: flattened.filter((frame) => frame.path.length > 1).length,
    layoutTables: 0,
    inlineHandlers: 0,
    hashLinks: 0,
    targetedNavigation: 0,
    postForms: 0,
  };
  let mainSignals: DirectDocumentSignals | undefined;
  const allFrames = [mainFrame, ...descendantFrames(mainFrame)];
  for (const frame of allFrames) {
    assertDirectSignal(signal);
    if (directFrameDepth(frame) > maxDepth) continue;
    try {
      const signals = await directDocumentSignals(frame);
      mainSignals ??= frame === mainFrame ? signals : undefined;
      aggregate.layoutTables += signals.layoutTables;
      aggregate.inlineHandlers += signals.inlineHandlers;
      aggregate.hashLinks += signals.hashLinks;
      aggregate.targetedNavigation += signals.targetedNavigation;
      aggregate.postForms += signals.postForms;
    } catch {
      // A detached or inaccessible frame remains represented in the graph.
    }
  }
  mainSignals ??= await directDocumentSignals(mainFrame);
  const categories: LegacyPageProfile[] = [];
  if (aggregate.frames > 0) categories.push("legacy-frames");
  if (aggregate.layoutTables > 0) categories.push("legacy-table-layout");
  if (aggregate.postForms > 0) categories.push("legacy-form-post");
  if (
    aggregate.inlineHandlers > 0 ||
    aggregate.hashLinks > 0 ||
    aggregate.targetedNavigation > 0
  ) {
    categories.push("legacy-script-navigation");
  }
  const profile: LegacyPageProfile = categories.length === 0
    ? "modern"
    : categories.length === 1
      ? categories[0]!
      : "hybrid";
  return {
    profile,
    signals: aggregate,
    pageSignature: directHash([
      mainSignals.origin,
      mainSignals.pathname,
      mainSignals.title,
      mainSignals.childElementCount,
      JSON.stringify(aggregate),
    ].join("|")),
    frameGraphSignature: directHash(JSON.stringify(
      frames.map(stripDirectFrameForSignature),
    )),
    frames,
  };
}

async function inspectDirectFrame(
  frame: Frame,
  index: number,
  parentPath: readonly string[],
  depth: number,
  maxDepth: number,
  signal?: AbortSignal,
): Promise<LegacyFrameNode> {
  assertDirectSignal(signal);
  const element = await frame.frameElement().catch(() => undefined);
  const [rawName, rawId, rawSrc] = element
    ? await Promise.all([
        element.getAttribute("name").catch(() => null),
        element.getAttribute("id").catch(() => null),
        element.getAttribute("src").catch(() => null),
      ])
    : [null, null, null];
  const name = directCompact(rawName, 200);
  const id = directCompact(rawId, 200);
  const segment = name || id || String(index);
  const path = [...parentPath, segment];
  const src = directSafeUrl(rawSrc || frame.url());
  let status: LegacyFrameNode["status"] = "not-ready";
  let readyState: string | undefined;
  try {
    const state = await directFrameDocumentState(frame);
    readyState = state.readyState;
    status = readyState === "loading" ? "not-ready" : "ready";
  } catch {
    status = frame.isDetached() ? "inaccessible" : "not-ready";
  }
  const children: LegacyFrameNode[] = [];
  if (!frame.isDetached() && depth < maxDepth) {
    for (const [childIndex, child] of frame
      .childFrames()
      .slice(0, 100)
      .entries()) {
      children.push(
        await inspectDirectFrame(
          child,
          childIndex,
          path,
          depth + 1,
          maxDepth,
          signal,
        ),
      );
    }
  }
  return {
    path,
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    index,
    ...(src ? { src } : {}),
    status,
    ...(readyState ? { readyState } : {}),
    signature: directHash(
      [path.join("/"), name, id, src, status, readyState ?? ""].join("|"),
    ),
    children,
  };
}

function flattenDirectFrames(frames: readonly LegacyFrameNode[]): LegacyFrameNode[] {
  return frames.flatMap((frame) => [
    frame,
    ...flattenDirectFrames(frame.children),
  ]);
}

function descendantFrames(frame: Frame): Frame[] {
  return frame.childFrames().flatMap((child) => [
    child,
    ...descendantFrames(child),
  ]);
}

function directFrameDepth(frame: Frame): number {
  let depth = 0;
  let parent = frame.parentFrame();
  while (parent) {
    depth += 1;
    parent = parent.parentFrame();
  }
  return depth;
}

async function directDocumentSignals(
  frame: Frame,
): Promise<DirectDocumentSignals> {
  return evaluateDirectFunction<DirectDocumentSignals>(
    frame,
    DIRECT_DOCUMENT_SIGNALS_EVALUATION,
  );
}

async function directFrameDocumentState(
  frame: Frame,
): Promise<DirectFrameDocumentState> {
  const state = await evaluateDirectFunction<{
    readyState: string;
    value: string;
  }>(frame, DIRECT_DOCUMENT_STATE_EVALUATION);
  return {
    readyState: state.readyState,
    signature: directHash(state.value),
  };
}

function stripDirectFrameForSignature(frame: LegacyFrameNode): unknown {
  return {
    path: frame.path,
    name: frame.name ?? "",
    id: frame.id ?? "",
    src: frame.src ?? "",
    status: frame.status,
    children: frame.children.map(stripDirectFrameForSignature),
  };
}

function normalizeDirectReadyState(
  value: string,
): "loading" | "interactive" | "complete" {
  if (value === "loading" || value === "interactive") return value;
  return "complete";
}

function directFramePath(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((segment): segment is string => typeof segment === "string")
    : [];
}

function normalizeDirectIndexValue(
  value: object,
  framePath: readonly string[],
): unknown {
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return value;
  return {
    ...record,
    items: record.items.map((item) =>
      item && typeof item === "object"
        ? { ...(item as Record<string, unknown>), framePath: [...framePath] }
        : item),
  };
}

function mergeNavigationTelemetry(
  navigation: LegacyTelemetry,
  checkpoint: LegacyTelemetry,
  totalMs: number,
): LegacyTelemetry {
  const sum = (key: keyof LegacyTelemetry): number | undefined => {
    const left = navigation[key];
    const right = checkpoint[key];
    if (typeof left !== "number" && typeof right !== "number") return undefined;
    return Number(left ?? 0) + Number(right ?? 0);
  };
  return {
    totalMs: Math.max(0, Math.round(totalMs * 1_000) / 1_000),
    ...(sum("frameResolutionMs") === undefined
      ? {}
      : { frameResolutionMs: sum("frameResolutionMs") }),
    ...(sum("indexMs") === undefined ? {} : { indexMs: sum("indexMs") }),
    ...(sum("locatorMs") === undefined ? {} : { locatorMs: sum("locatorMs") }),
    ...(sum("interactionMs") === undefined
      ? {}
      : { interactionMs: sum("interactionMs") }),
    ...(sum("navigationMs") === undefined
      ? {}
      : { navigationMs: sum("navigationMs") }),
    ...(sum("candidateCount") === undefined
      ? {}
      : { candidateCount: sum("candidateCount") }),
    ...(navigation.cacheHit === undefined ? {} : { cacheHit: navigation.cacheHit }),
    ...(navigation.cacheInvalidated === undefined
      ? {}
      : { cacheInvalidated: navigation.cacheInvalidated }),
    strategy: [navigation.strategy, checkpoint.strategy]
      .filter(Boolean)
      .join("+") || undefined,
    retries: Number(navigation.retries ?? 0) + Number(checkpoint.retries ?? 0),
  };
}

function accumulateLegacyTelemetry(
  totals: Record<
    | "frameResolutionMs"
    | "indexMs"
    | "locatorMs"
    | "interactionMs"
    | "navigationMs"
    | "candidateCount",
    number
  >,
  telemetry: LegacyTelemetry,
): void {
  totals.frameResolutionMs += telemetry.frameResolutionMs ?? 0;
  totals.indexMs += telemetry.indexMs ?? 0;
  totals.locatorMs += telemetry.locatorMs ?? 0;
  totals.interactionMs += telemetry.interactionMs ?? 0;
  totals.navigationMs += telemetry.navigationMs ?? 0;
  totals.candidateCount += telemetry.candidateCount ?? 0;
}

async function cancelDirectEvaluation(
  frame: Frame,
  evaluationId: string,
): Promise<void> {
  const encodedId = JSON.stringify(evaluationId);
  await evaluateDirectFunction(frame, `() => {
    const registry = globalThis.__mcpLegacyCancellation;
    if (!registry || !Object.prototype.hasOwnProperty.call(registry, ${encodedId})) return false;
    registry[${encodedId}] = true;
    return true;
  }`).then(() => undefined, () => undefined);
}

async function evaluateDirectFunction<T>(
  frame: Frame,
  source: string,
): Promise<T> {
  return await frame.evaluate(
    (expression) => {
      const factory = globalThis.eval(`(${expression})`) as () => unknown;
      return factory();
    },
    source,
  ) as T;
}

async function directDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  assertDirectSignal(signal);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
  assertDirectSignal(signal);
}

function assertDirectSignal(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Legacy browser operation was cancelled.");
  }
}

function isRetryableDirectFrameResolutionError(error: unknown): boolean {
  if (error instanceof AppError) {
    return ["FRAME_NOT_FOUND", "FRAME_NOT_READY"].includes(error.code);
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "FRAME_NOT_FOUND" || code === "FRAME_NOT_READY") return true;
  }
  return isTransientDirectFrameContextError(error);
}

function isTransientDirectFrameContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|frame was detached|cannot find context with specified id|most likely because of a navigation/i.test(
    message,
  );
}

function directElapsedMs(startedAt: number): number {
  return Math.max(
    0,
    Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  );
}

function normalizeDirectText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
}

function directCompact(value: string | null, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function directSafeUrl(value: string): string {
  if (!value || value === "about:blank") return "";
  try {
    const url = new URL(value);
    return url.origin === "null" ? "" : url.origin + url.pathname;
  } catch {
    return "";
  }
}

function directHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const DIRECT_DOCUMENT_SIGNALS_EVALUATION = `() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const tables = Array.from(document.querySelectorAll("table"));
  return {
    layoutTables: tables.filter((table) => !table.querySelector("th") || table.getAttribute("role") === "presentation").length,
    inlineHandlers: document.querySelectorAll("[onclick],[onchange],[onmouseover],[onmousedown]").length,
    hashLinks: Array.from(document.querySelectorAll("a[href]")).filter((link) => link.getAttribute("href") === "#").length,
    targetedNavigation: document.querySelectorAll("[target]").length,
    postForms: Array.from(document.forms).filter((form) => normalize(form.method) === "post").length,
    origin: location.origin,
    pathname: location.pathname,
    title: document.title,
    childElementCount: document.documentElement ? document.documentElement.childElementCount : 0
  };
}`;

const DIRECT_DOCUMENT_STATE_EVALUATION = `() => {
  const root = document.body || document.documentElement;
  return {
    readyState: document.readyState,
    value: [
      location.href,
      document.title,
      root ? String(root.innerText || root.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 2000) : "",
      root ? root.childElementCount : 0
    ].join("|")
  };
}`;

async function waitForDriverCheckpoint(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Legacy browser operation was cancelled.");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  if (signal?.aborted) {
    throw abortSignalError(signal, "Legacy browser operation was cancelled.");
  }
}

function parseEnvelope<T>(
  value: unknown,
): LegacyEvaluationEnvelope<T> | LegacyEvaluationErrorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      "RELAY_PROTOCOL_ERROR",
      "Legacy browser evaluation returned an invalid envelope.",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && "result" in record) {
    return { ok: true, result: record.result as T };
  }
  if (record.ok === false && record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : "INTERNAL_ERROR",
        message:
          typeof error.message === "string"
            ? error.message.slice(0, 2_000)
            : "Legacy browser evaluation failed.",
      },
    };
  }
  throw new AppError(
    "RELAY_PROTOCOL_ERROR",
    "Legacy browser evaluation returned an invalid result.",
  );
}

function normalizeLegacyErrorCode(value: string): ErrorCode {
  return (errorCodes as readonly string[]).includes(value)
    ? (value as ErrorCode)
    : "INTERNAL_ERROR";
}

function buildLegacyEvaluationFunction(
  operation: string,
  input: unknown,
  cancellationId: string,
): string {
  const request = JSON.stringify({ operation, input, cancellationId });
  return `async () => {
    const request = ${request};
    const cancellationRegistry = globalThis.__mcpLegacyCancellation ??= Object.create(null);
    cancellationRegistry[request.cancellationId] = false;
    ${LEGACY_EVALUATION_RUNTIME}
    try {
      assertNotCancelled();
      const result = await executeLegacyOperation(request.operation, request.input || {});
      assertNotCancelled();
      return { ok: true, result };
    } catch (error) {
      const normalized = normalizeLegacyError(error);
      return { ok: false, error: normalized };
    } finally {
      delete cancellationRegistry[request.cancellationId];
    }
  }`;
}

const LEGACY_EVALUATION_RUNTIME = String.raw`
function legacyError(code, message) {
  const error = new Error(message);
  error.legacyCode = code;
  return error;
}
function normalizeLegacyError(error) {
  const code = error && typeof error.legacyCode === 'string'
    ? error.legacyCode
    : error && error.name === 'SecurityError'
      ? 'FRAME_CROSS_ORIGIN'
      : 'INTERNAL_ERROR';
  const message = error && typeof error.message === 'string'
    ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 2000)
    : 'Legacy browser operation failed.';
  return { code, message };
}
function assertNotCancelled() {
  const registry = globalThis.__mcpLegacyCancellation;
  if (registry && registry[request.cancellationId] === true) {
    throw legacyError('OPERATION_CANCELLED', 'Legacy browser operation was cancelled.');
  }
}
async function cancellationCheckpoint() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertNotCancelled();
}
function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
function elapsedMs(startedAt) {
  return Math.max(0, Math.round((nowMs() - startedAt) * 1000) / 1000);
}
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
}
function compactText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function hashValue(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\' + character);
}
function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, document.baseURI);
    return url.origin === 'null' ? '' : url.origin + url.pathname;
  } catch {
    return '';
  }
}
function stableSelector(element) {
  if (element.id) return '#' + cssEscape(element.id);
  const name = element.getAttribute('name');
  if (name) {
    const byName = element.ownerDocument.querySelectorAll(
      element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]',
    );
    if (byName.length === 1) {
      return element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
    }
  }
  const href = element.getAttribute('href');
  if (href && href !== '#') {
    const matches = element.ownerDocument.querySelectorAll(
      element.tagName.toLowerCase() + '[href="' + cssEscape(href) + '"]',
    );
    if (matches.length === 1) {
      return element.tagName.toLowerCase() + '[href="' + cssEscape(href) + '"]';
    }
  }
  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && parts.length < 8) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift('#' + cssEscape(current.id));
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}
function frameSelectorSegment(frame, index) {
  return frame.getAttribute('name') || frame.getAttribute('id') || String(index);
}
function frameElements(doc) {
  return Array.from(doc.querySelectorAll('frame,iframe'));
}
function resolveFrameDocument(framePath) {
  let doc = document;
  for (const segment of framePath || []) {
    const frames = frameElements(doc);
    const numeric = /^\d+$/.test(segment) ? Number(segment) : -1;
    const frame = frames.find((candidate, index) =>
      candidate.getAttribute('name') === segment ||
      candidate.getAttribute('id') === segment ||
      index === numeric
    );
    if (!frame) throw legacyError('FRAME_NOT_FOUND', 'Frame not found: ' + segment);
    try {
      const next = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
      if (!next) {
        const src = frame.getAttribute('src');
        if (src) {
          try {
            if (new URL(src, doc.baseURI).origin !== location.origin) {
              throw legacyError('FRAME_CROSS_ORIGIN', 'Frame is cross-origin: ' + segment);
            }
          } catch (error) {
            if (error && error.legacyCode) throw error;
          }
        }
        throw legacyError('FRAME_NOT_READY', 'Frame is not ready: ' + segment);
      }
      doc = next;
    } catch (error) {
      if (error && error.legacyCode) throw error;
      throw legacyError('FRAME_CROSS_ORIGIN', 'Frame is cross-origin: ' + segment);
    }
  }
  return doc;
}
function inspectFrame(frame, index, parentPath, depth, maxDepth) {
  const segment = frameSelectorSegment(frame, index);
  const path = parentPath.concat(segment);
  const name = compactText(frame.getAttribute('name'), 200);
  const id = compactText(frame.getAttribute('id'), 200);
  const rawSrc = frame.getAttribute('src') || '';
  const src = safeUrl(rawSrc);
  let status = 'not-ready';
  let readyState;
  let children = [];
  try {
    const doc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
    if (!doc) {
      if (src) {
        try {
          status = new URL(rawSrc, document.baseURI).origin === location.origin ? 'not-ready' : 'cross-origin';
        } catch {
          status = 'inaccessible';
        }
      }
    } else {
      readyState = doc.readyState;
      status = readyState === 'loading' ? 'not-ready' : 'ready';
      if (depth < maxDepth) {
        children = frameElements(doc).map((child, childIndex) =>
          inspectFrame(child, childIndex, path, depth + 1, maxDepth),
        );
      }
    }
  } catch {
    status = 'cross-origin';
  }
  return {
    path,
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    index,
    ...(src ? { src } : {}),
    status,
    ...(readyState ? { readyState } : {}),
    signature: hashValue([path.join('/'), name, id, src, status, readyState].join('|')),
    children,
  };
}
function collectFrameGraph(maxDepth) {
  return frameElements(document).map((frame, index) => inspectFrame(frame, index, [], 0, maxDepth));
}
function flattenFrames(frames) {
  const result = [];
  for (const frame of frames) {
    result.push(frame);
    result.push(...flattenFrames(frame.children || []));
  }
  return result;
}
function collectSignalsFromDocument(doc) {
  const tables = Array.from(doc.querySelectorAll('table'));
  return {
    layoutTables: tables.filter((table) => !table.querySelector('th') || table.getAttribute('role') === 'presentation').length,
    inlineHandlers: doc.querySelectorAll('[onclick],[onchange],[onmouseover],[onmousedown]').length,
    hashLinks: Array.from(doc.querySelectorAll('a[href]')).filter((link) => link.getAttribute('href') === '#').length,
    targetedNavigation: doc.querySelectorAll('[target]').length,
    postForms: Array.from(doc.forms).filter((form) => normalizeText(form.method) === 'post').length,
  };
}
function collectSignalsRecursively(doc, depth, maxDepth) {
  const aggregate = collectSignalsFromDocument(doc);
  if (depth >= maxDepth) return aggregate;
  for (const frame of frameElements(doc)) {
    try {
      const child = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
      if (!child) continue;
      const nested = collectSignalsRecursively(child, depth + 1, maxDepth);
      aggregate.layoutTables += nested.layoutTables;
      aggregate.inlineHandlers += nested.inlineHandlers;
      aggregate.hashLinks += nested.hashLinks;
      aggregate.targetedNavigation += nested.targetedNavigation;
      aggregate.postForms += nested.postForms;
    } catch {
      // Cross-origin frames are represented in the frame graph and are not inspected.
    }
  }
  return aggregate;
}
function profileDocument(maxDepth) {
  const frames = collectFrameGraph(maxDepth);
  const flattened = flattenFrames(frames);
  const signals = collectSignalsRecursively(document, 0, maxDepth);
  const aggregate = {
    frames: flattened.length,
    nestedFrames: flattened.filter((frame) => frame.path.length > 1).length,
    ...signals,
  };
  const categories = [];
  if (aggregate.frames > 0) categories.push('legacy-frames');
  if (aggregate.layoutTables > 0) categories.push('legacy-table-layout');
  if (aggregate.postForms > 0) categories.push('legacy-form-post');
  if (aggregate.inlineHandlers > 0 || aggregate.hashLinks > 0 || aggregate.targetedNavigation > 0) {
    categories.push('legacy-script-navigation');
  }
  const profile = categories.length === 0 ? 'modern' : categories.length === 1 ? categories[0] : 'hybrid';
  const pageSignature = hashValue([
    location.origin,
    location.pathname,
    document.title,
    document.documentElement ? document.documentElement.childElementCount : 0,
    JSON.stringify(aggregate),
  ].join('|'));
  const frameGraphSignature = hashValue(JSON.stringify(frames.map(stripFrameForSignature)));
  return { profile, signals: aggregate, pageSignature, frameGraphSignature, frames };
}
function stripFrameForSignature(frame) {
  return {
    path: frame.path,
    name: frame.name || '',
    id: frame.id || '',
    src: frame.src || '',
    status: frame.status,
    children: (frame.children || []).map(stripFrameForSignature),
  };
}
function isVisible(element) {
  if (!element || element.nodeType !== 1) return false;
  const style = element.ownerDocument.defaultView
    ? element.ownerDocument.defaultView.getComputedStyle(element)
    : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function isEnabled(element) {
  return !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
}
function readableElementText(element) {
  const type = normalizeText(element.getAttribute('type'));
  const labelValue = ['button', 'submit', 'reset', 'image'].includes(type)
    ? ('value' in element ? element.value : element.getAttribute('value'))
    : '';
  const primaryText = element.innerText || element.textContent;
  return compactText([
    primaryText,
    labelValue,
    element.getAttribute('title'),
    element.getAttribute('alt'),
    element.getAttribute('aria-label'),
  ].filter(Boolean).join(' '), 500);
}
function extractableElementText(element) {
  const tag = normalizeText(element.tagName);
  const type = normalizeText(element.getAttribute('type'));
  if (type === 'password') return '';
  if (tag === 'select') {
    const selected = Array.from(element.selectedOptions || []);
    return compactText(selected.map((option) => option.value || option.text).join(' '), 100000);
  }
  if ((tag === 'input' || tag === 'textarea') && 'value' in element) {
    return compactText(element.value, 100000);
  }
  return readableElementText(element);
}
function ancestorSummary(element) {
  const result = [];
  let current = element.parentElement;
  while (current && result.length < 6) {
    const text = compactText([
      current.tagName.toLowerCase(),
      current.id ? '#' + current.id : '',
      current.getAttribute('name') || '',
      current.getAttribute('role') || '',
    ].filter(Boolean).join(' '), 300);
    if (text) result.push(text);
    current = current.parentElement;
  }
  return result;
}
function interactiveElements(root) {
  return Array.from(root.querySelectorAll(
    'a,button,input,select,textarea,option,img,[onclick],[onchange],[role="button"],[role="link"],[tabindex]'
  ));
}
function resolveIndexRoot(doc, rootSelector) {
  if (!rootSelector) return doc;
  let root;
  try {
    root = doc.querySelector(rootSelector);
  } catch {
    throw legacyError('LOCATOR_NOT_FOUND', 'Legacy DOM index root selector is invalid.');
  }
  if (!root) throw legacyError('LOCATOR_NOT_FOUND', 'Legacy DOM index root was not found.');
  return root;
}
function matchesIndexQuery(element, query) {
  if (!query) return true;
  const haystack = normalizeText([
    readableElementText(element),
    element.getAttribute('id'),
    element.getAttribute('name'),
    element.getAttribute('title'),
    element.getAttribute('alt'),
    element.getAttribute('aria-label'),
    element.getAttribute('href'),
    element.getAttribute('target'),
  ].filter(Boolean).join(' '));
  return haystack.includes(normalizeText(query));
}
function elementItem(element, framePath) {
  const selector = stableSelector(element);
  const onclick = element.getAttribute('onclick');
  const tag = element.tagName.toLowerCase();
  const id = compactText(element.getAttribute('id'), 256);
  const name = compactText(element.getAttribute('name'), 256);
  const type = compactText(element.getAttribute('type'), 100);
  const role = compactText(element.getAttribute('role'), 100);
  const href = safeUrl(element.getAttribute('href'));
  const target = compactText(element.getAttribute('target'), 256);
  const ariaLabel = compactText(element.getAttribute('aria-label'), 500);
  const title = compactText(element.getAttribute('title'), 500);
  const alt = compactText(element.getAttribute('alt'), 500);
  const ref = 'lref_' + hashValue([framePath.join('/'), selector, id, name, href, target].join('|'));
  return {
    ref,
    tag,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(role ? { role } : {}),
    text: readableElementText(element),
    ...(href ? { href } : {}),
    ...(target ? { target } : {}),
    ...(onclick ? { onclickSignature: hashValue(onclick) } : {}),
    ...(ariaLabel ? { ariaLabel } : {}),
    ...(title ? { title } : {}),
    ...(alt ? { alt } : {}),
    visible: isVisible(element),
    enabled: isEnabled(element),
    selector,
    framePath,
    ancestors: ancestorSummary(element),
  };
}
function indexDocument(doc, framePath, options) {
  const root = resolveIndexRoot(doc, options.rootSelector);
  const offset = Math.max(0, options.offset || 0);
  const limit = Math.max(1, options.limit || 500);
  const elements = interactiveElements(root).filter((element) =>
    (!options.visibleOnly || isVisible(element)) && matchesIndexQuery(element, options.query)
  );
  const page = elements.slice(offset, offset + limit);
  const nextOffset = offset + page.length < elements.length ? offset + page.length : undefined;
  return {
    items: page.map((element) => elementItem(element, framePath)),
    truncated: nextOffset !== undefined,
    offset,
    totalCount: elements.length,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}
function locatorCandidates(doc, framePath, locator, rootSelector) {
  const root = resolveIndexRoot(doc, rootSelector);
  let elements;
  if (locator.selector) {
    try {
      elements = Array.from(root.querySelectorAll(locator.selector));
    } catch {
      throw legacyError('LOCATOR_NOT_FOUND', 'Legacy locator selector is invalid.');
    }
  } else if (locator.id) {
    elements = Array.from(root.querySelectorAll('[id]')).filter((element) =>
      element.getAttribute('id') === locator.id
    );
  } else if (locator.name) {
    elements = Array.from(root.querySelectorAll('[name]')).filter((element) =>
      element.getAttribute('name') === locator.name
    );
  } else {
    elements = interactiveElements(root);
  }
  const candidates = [];
  for (const element of elements) {
    const item = elementItem(element, framePath);
    let score = 0;
    let strategy = 'structure';
    let rejected = false;
    const apply = (condition, points, name) => {
      if (!condition) {
        rejected = true;
        return;
      }
      if (points > score) {
        score = points;
        strategy = name;
      }
    };
    if (locator.ref) apply(item.ref === locator.ref, 1000, 'ref');
    if (locator.id) apply(item.id === locator.id, 900, 'id');
    if (locator.name) apply(item.name === locator.name, 850, 'name');
    if (locator.selector) apply(true, 800, 'selector');
    if (locator.href) apply(item.href === safeUrl(locator.href), 750, 'href');
    if (locator.target) apply(item.target === locator.target, 740, 'target');
    if (locator.onclickSignature) apply(item.onclickSignature === locator.onclickSignature, 730, 'onclick-signature');
    if (locator.tag) apply(item.tag === normalizeText(locator.tag), 520, 'attributes');
    if (locator.type) apply(normalizeText(item.type) === normalizeText(locator.type), 520, 'attributes');
    if (locator.role) apply(normalizeText(item.role) === normalizeText(locator.role), 520, 'attributes');
    if (locator.ancestorText) {
      const ancestorHaystack = normalizeText(item.ancestors.join(' '));
      apply(ancestorHaystack.includes(normalizeText(locator.ancestorText)), 510, 'structure');
    }
    if (locator.text) {
      const needle = normalizeText(locator.text);
      const haystack = normalizeText(item.text);
      if (haystack === needle) {
        score = Math.max(score, 650);
        strategy = score === 650 ? 'exact-text' : strategy;
      } else if (locator.exact !== true && haystack.includes(needle)) {
        score = Math.max(score, 550);
        strategy = score === 550 ? 'partial-text' : strategy;
      } else {
        rejected = true;
      }
    }
    if (rejected) continue;
    if (item.visible) score += 20;
    else score -= 500;
    if (!item.enabled) score -= 100;
    candidates.push({ element, item, score, strategy });
  }
  candidates.sort((left, right) => right.score - left.score || left.item.selector.localeCompare(right.item.selector));
  return candidates;
}
function resolveLocator(doc, framePath, locator, rootSelector) {
  const startedAt = nowMs();
  const candidates = locatorCandidates(doc, framePath, locator || {}, rootSelector);
  if (candidates.length === 0) {
    throw legacyError('LOCATOR_NOT_FOUND', 'No element matched the legacy locator.');
  }
  const selectedIndex = Number.isInteger(locator.index) ? locator.index : 0;
  const selected = candidates[selectedIndex];
  if (!selected) throw legacyError('LOCATOR_NOT_FOUND', 'Legacy locator index is outside the candidate set.');
  if (selected.score < 500) {
    throw legacyError('LOCATOR_LOW_CONFIDENCE', 'Legacy locator confidence is too low.');
  }
  const second = candidates[selectedIndex === 0 ? 1 : 0];
  if (locator.index === undefined && second && Math.abs(selected.score - second.score) <= 15) {
    throw legacyError('LOCATOR_AMBIGUOUS', 'Legacy locator matched multiple equivalent candidates.');
  }
  return {
    ...selected,
    candidateCount: candidates.length,
    durationMs: elapsedMs(startedAt),
  };
}
function classifyRisk(element) {
  const value = normalizeText([
    element.tagName,
    element.getAttribute('type'),
    element.getAttribute('role'),
    readableElementText(element),
  ].filter(Boolean).join(' '));
  if (/\b(delete|remove|cancel|terminate|unsubscribe|deactivate|excluir|remover|cancelar)\b/.test(value)) return 'destructive';
  if (/\b(buy|purchase|pay|checkout|order|comprar|pagar|pagamento)\b/.test(value)) return 'submit';
  if (/\b(send|publish|save|confirm|apply|create|update|submit|enviar|publicar|salvar|confirmar)\b/.test(value)) return 'submit';
  const type = normalizeText(element.getAttribute('type'));
  if (type === 'submit' || type === 'image') return 'submit';
  return 'navigate';
}
function isLikelyDocumentNavigation(element) {
  const tag = normalizeText(element.tagName);
  const type = normalizeText(element.getAttribute('type'));
  if (type === 'submit' || type === 'image') return true;
  if (tag === 'a') {
    const href = compactText(element.getAttribute('href'), 2000);
    if (href && href !== '#' && !href.toLocaleLowerCase('en-US').startsWith('javascript:')) {
      return true;
    }
  }
  const inlineHandler = normalizeText(element.getAttribute('onclick'));
  return Boolean(element.getAttribute('formaction')) ||
    inlineHandler.includes('submit(') ||
    inlineHandler.includes('filasubmit');
}
function assertAuthorized(element, authorized, context) {
  const risk = classifyRisk(element);
  if ((risk === 'submit' || risk === 'destructive') && authorized !== true) {
    const target = compactText(
      readableElementText(element) ||
      element.getAttribute('id') ||
      element.getAttribute('name') ||
      element.tagName,
      200,
    );
    throw legacyError(
      'ACTION_BLOCKED_BY_POLICY',
      'Legacy action requires explicit confirmation: ' + JSON.stringify({
        ...context,
        risk,
        target,
      }),
    );
  }
}
function assertKeyboardAuthorized(authorized, context) {
  if (authorized === true) return;
  throw legacyError(
    'ACTION_BLOCKED_BY_POLICY',
    'Legacy action requires explicit confirmation: ' + JSON.stringify({
      ...context,
      risk: 'submit',
      target: 'keyboard:Enter',
    }),
  );
}
function safeOuterHtml(element) {
  const clone = element.cloneNode(true);
  for (const sensitive of clone.querySelectorAll ? clone.querySelectorAll('input,textarea') : []) {
    sensitive.removeAttribute('value');
    if ('value' in sensitive) sensitive.value = '';
  }
  if (clone.removeAttribute) {
    clone.removeAttribute('value');
    clone.removeAttribute('data-token');
    clone.removeAttribute('data-secret');
  }
  return clone.outerHTML;
}
function extractElement(element, format, framePath) {
  if (format === 'html') return safeOuterHtml(element);
  if (format === 'json') return elementItem(element, framePath);
  return extractableElementText(element);
}
async function delay(ms) {
  const deadline = Date.now() + Math.max(0, ms);
  assertNotCancelled();
  do {
    const remaining = Math.max(0, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    assertNotCancelled();
  } while (Date.now() < deadline);
}
async function waitForCondition(framePath, input, absoluteDeadline) {
  while (Date.now() < absoluteDeadline) {
    const doc = resolveFrameDocument(framePath);
    if (input.state === 'ready' && doc.readyState !== 'loading') return true;
    if (input.text && normalizeText(doc.body ? doc.body.innerText : '').includes(normalizeText(input.text))) return true;
    if (input.locator) {
      try {
        const resolved = resolveLocator(doc, framePath, input.locator);
        if (input.state === 'hidden') {
          if (!isVisible(resolved.element)) return true;
        } else if (input.state === 'visible') {
          if (isVisible(resolved.element)) return true;
        } else {
          return true;
        }
      } catch (error) {
        if (error && !['LOCATOR_NOT_FOUND', 'LOCATOR_LOW_CONFIDENCE'].includes(error.legacyCode)) throw error;
        if (input.state === 'hidden') return true;
      }
    }
    await delay(50);
  }
  throw legacyError('STATE_NOT_REACHED', 'Legacy frame state was not reached before the deadline.');
}
function assertLegacyState(doc, framePath, step) {
  if (step.condition === 'frameReady') {
    if (doc.readyState === 'loading') throw legacyError('FRAME_NOT_READY', 'Frame is still loading.');
    return true;
  }
  const resolved = resolveLocator(doc, framePath, step.locator);
  const text = extractableElementText(resolved.element);
  let passed = false;
  if (step.condition === 'exists') passed = true;
  if (step.condition === 'visible') passed = isVisible(resolved.element);
  if (step.condition === 'enabled') passed = isEnabled(resolved.element);
  if (step.condition === 'textEquals') passed = normalizeText(text) === normalizeText(step.expected);
  if (step.condition === 'textContains') passed = normalizeText(text).includes(normalizeText(step.expected));
  if (!passed) throw legacyError('STATE_NOT_REACHED', 'Legacy assertion failed: ' + step.condition);
  return true;
}
async function executeFrameSequence(input) {
  const startedAt = nowMs();
  const absoluteDeadline = Date.now() + Math.max(1, input.timeoutMs || 60000);
  const results = [];
  let frameResolutionMs = 0;
  let indexMs = 0;
  let locatorMs = 0;
  let interactionMs = 0;
  let navigationMs = 0;
  let candidateCount = 0;
  let strategy;
  for (let index = 0; index < input.steps.length; index += 1) {
    assertNotCancelled();
    const step = input.steps[index];
    if (step.action === 'press' && step.mode === 'native') {
      throw legacyError('CAPABILITY_UNSUPPORTED', 'Native press must be executed by the Browser Worker driver.');
    }
    if (step.action === 'press' && normalizeText(step.key) === 'enter' && !step.locator) {
      assertKeyboardAuthorized(step.authorized, { kind: 'step', index });
      continue;
    }
    if (step.action !== 'click' && !(step.action === 'press' && normalizeText(step.key) === 'enter')) {
      continue;
    }
    const framePath = step.framePath || [];
    const doc = resolveFrameDocument(framePath);
    for (const candidate of locatorCandidates(doc, framePath, step.locator || {})) {
      assertAuthorized(candidate.element, step.authorized, { kind: 'step', index });
    }
  }
  for (let index = 0; index < input.steps.length; index += 1) {
    assertNotCancelled();
    if (Date.now() >= absoluteDeadline) throw legacyError('NAVIGATION_TIMEOUT', 'Legacy sequence exceeded its deadline.');
    const step = input.steps[index];
    const frameStartedAt = nowMs();
    const framePath = step.framePath || [];
    const doc = resolveFrameDocument(framePath);
    frameResolutionMs += elapsedMs(frameStartedAt);
    if (step.action === 'index') {
      const phaseStartedAt = nowMs();
      const indexed = indexDocument(doc, framePath, {
        rootSelector: step.rootSelector,
        query: step.query,
        offset: step.offset || 0,
        limit: step.limit || 500,
        visibleOnly: step.visibleOnly === true,
      });
      indexMs += elapsedMs(phaseStartedAt);
      results.push({ index, action: step.action, completed: true, value: indexed });
      continue;
    }
    if (step.action === 'waitFor') {
      const phaseStartedAt = nowMs();
      const stepDeadline = Math.min(absoluteDeadline, Date.now() + (step.timeoutMs || 10000));
      await waitForCondition(framePath, step, stepDeadline);
      navigationMs += elapsedMs(phaseStartedAt);
      results.push({ index, action: step.action, completed: true });
      continue;
    }
    if (step.action === 'assert') {
      assertLegacyState(doc, framePath, step);
      results.push({ index, action: step.action, completed: true });
      continue;
    }
    if (step.action === 'extract' && !step.locator) {
      const root = doc.body || doc.documentElement;
      const value = step.format === 'html'
        ? safeOuterHtml(root)
        : step.format === 'json'
          ? { title: compactText(doc.title, 500), url: safeUrl(doc.location ? doc.location.href : ''), text: compactText(root ? root.innerText || root.textContent : '', 100000) }
          : compactText(root ? root.innerText || root.textContent : '', 100000);
      results.push({ index, action: step.action, completed: true, value });
      continue;
    }
    if (step.action === 'press' && !step.locator) {
      if (normalizeText(step.key) === 'enter' && step.authorized !== true) {
        assertKeyboardAuthorized(step.authorized, { kind: 'step', index });
      }
      const interactionStartedAt = nowMs();
      await cancellationCheckpoint();
      const target = doc.activeElement || doc.body;
      const view = target.ownerDocument.defaultView || window;
      const dispatchKeyboard = () => {
        target.dispatchEvent(new view.KeyboardEvent('keydown', { key: step.key, bubbles: true }));
        target.dispatchEvent(new view.KeyboardEvent('keyup', { key: step.key, bubbles: true }));
      };
      if (step.deferNavigation === true) setTimeout(dispatchKeyboard, 0);
      else dispatchKeyboard();
      interactionMs += elapsedMs(interactionStartedAt);
      results.push({ index, action: step.action, completed: true });
      continue;
    }
    const resolved = resolveLocator(doc, framePath, step.locator);
    locatorMs += resolved.durationMs;
    candidateCount += resolved.candidateCount;
    strategy = resolved.strategy;
    const element = resolved.element;
    const interactionStartedAt = nowMs();
    let value;
    if (step.action === 'click') {
      assertAuthorized(element, step.authorized, { kind: 'step', index });
      await cancellationCheckpoint();
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const clickable = element.closest('a,button') || element;
      if (step.deferNavigation === true) setTimeout(() => clickable.click(), 0);
      else clickable.click();
    } else if (step.action === 'fill') {
      await cancellationCheckpoint();
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      if ('value' in element) {
        element.value = step.value;
        const view = element.ownerDocument.defaultView || window;
        element.dispatchEvent(new view.Event('input', { bubbles: true }));
        element.dispatchEvent(new view.Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = step.value;
        const view = element.ownerDocument.defaultView || window;
        element.dispatchEvent(new view.Event('input', { bubbles: true }));
      } else {
        throw legacyError('CAPABILITY_UNSUPPORTED', 'Resolved legacy element is not fillable.');
      }
    } else if (step.action === 'select') {
      await cancellationCheckpoint();
      if (normalizeText(element.tagName) !== 'select') {
        throw legacyError('CAPABILITY_UNSUPPORTED', 'Resolved legacy element is not a select element.');
      }
      const option = Array.from(element.options).find((candidate) =>
        candidate.value === step.value || normalizeText(candidate.text) === normalizeText(step.value)
      );
      if (!option) throw legacyError('LOCATOR_NOT_FOUND', 'Legacy select option was not found.');
      element.value = option.value;
      const view = element.ownerDocument.defaultView || window;
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
    } else if (step.action === 'press') {
      await cancellationCheckpoint();
      if (normalizeText(step.key) === 'enter') {
        assertAuthorized(element, step.authorized, { kind: 'step', index });
      }
      element.focus();
      const view = element.ownerDocument.defaultView || window;
      const dispatchKeyboard = () => {
        element.dispatchEvent(new view.KeyboardEvent('keydown', { key: step.key, bubbles: true }));
        element.dispatchEvent(new view.KeyboardEvent('keyup', { key: step.key, bubbles: true }));
      };
      if (step.deferNavigation === true) setTimeout(dispatchKeyboard, 0);
      else dispatchKeyboard();
    } else if (step.action === 'extract') {
      value = extractElement(element, step.format || 'text', framePath);
    }
    interactionMs += elapsedMs(interactionStartedAt);
    results.push({
      index,
      action: step.action,
      completed: true,
      ...(value === undefined ? {} : { value }),
      strategy: resolved.strategy,
      ref: resolved.item.ref,
    });
  }
  return {
    completed: true,
    steps: results,
    telemetry: {
      totalMs: elapsedMs(startedAt),
      frameResolutionMs,
      indexMs,
      locatorMs,
      interactionMs,
      navigationMs,
      candidateCount,
      ...(strategy ? { strategy } : {}),
      retries: 0,
    },
  };
}
async function focusForNativePress(input) {
  const startedAt = nowMs();
  const step = input.step || {};
  const framePath = step.framePath || [];
  const frameStartedAt = nowMs();
  const doc = resolveFrameDocument(framePath);
  const frameResolutionMs = elapsedMs(frameStartedAt);
  let element = doc.activeElement || doc.body || doc.documentElement;
  let strategy = 'active-element';
  let ref;
  let locatorMs = 0;
  let candidateCount = 0;
  if (step.locator) {
    const locatorStartedAt = nowMs();
    const resolved = resolveLocator(doc, framePath, step.locator);
    locatorMs = elapsedMs(locatorStartedAt);
    candidateCount = resolved.candidateCount;
    strategy = resolved.strategy;
    ref = resolved.item.ref;
    element = resolved.element;
  }
  if (!element || typeof element.focus !== 'function') {
    throw legacyError('CAPABILITY_UNSUPPORTED', 'Legacy native press target is not focusable.');
  }
  if (normalizeText(step.key) === 'enter') {
    assertAuthorized(element, step.authorized, { kind: 'step', index: 0 });
  }
  const interactionStartedAt = nowMs();
  await cancellationCheckpoint();
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  }
  element.focus();
  const interactionMs = elapsedMs(interactionStartedAt);
  return {
    ...(ref ? { ref } : {}),
    strategy,
    telemetry: {
      totalMs: elapsedMs(startedAt),
      frameResolutionMs,
      locatorMs,
      interactionMs,
      candidateCount,
      strategy,
      retries: 0,
    },
  };
}
function documentSignature(doc) {
  const root = doc.body || doc.documentElement;
  return hashValue([
    doc.location ? doc.location.href : '',
    doc.title,
    root ? compactText(root.innerText || root.textContent || '', 2000) : '',
    root ? root.childElementCount : 0,
  ].join('|'));
}
async function resolvePathLocatorWithRetry(doc, framePath, locator, rootSelector, deadline) {
  let retries = 0;
  let lastError;
  while (Date.now() < deadline) {
    assertNotCancelled();
    try {
      return { resolved: resolveLocator(doc, framePath, locator, rootSelector), retries };
    } catch (error) {
      if (!error || !['LOCATOR_NOT_FOUND', 'LOCATOR_LOW_CONFIDENCE'].includes(error.legacyCode)) throw error;
      lastError = error;
      retries += 1;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw legacyError(
    lastError && lastError.legacyCode ? lastError.legacyCode : 'STATE_NOT_REACHED',
    lastError && lastError.message ? lastError.message : 'Legacy path locator did not become interactable before the deadline.',
  );
}
function shouldPreserveExpandedPathState(doc, framePath, currentLabel, nextLabel, rootSelector) {
  let next;
  try {
    next = resolveLocator(doc, framePath, { text: nextLabel }, rootSelector);
  } catch (error) {
    if (error && ['LOCATOR_NOT_FOUND', 'LOCATOR_LOW_CONFIDENCE'].includes(error.legacyCode)) return false;
    throw error;
  }
  if (!next.item.visible) return false;
  const currentCandidates = locatorCandidates(doc, framePath, { text: currentLabel }, rootSelector);
  const visibleCurrent = currentCandidates.some((candidate) => candidate.item.visible && candidate.score >= 500);
  const hiddenEquivalent = currentCandidates.some((candidate) =>
    !candidate.item.visible && normalizeText(candidate.item.text) === normalizeText(currentLabel)
  );
  return visibleCurrent && hiddenEquivalent;
}
function cacheEntryMatches(cached, profile, pathLength) {
  return Boolean(
    cached &&
    cached.pageSignature === profile.pageSignature &&
    cached.frameGraphSignature === profile.frameGraphSignature &&
    Array.isArray(cached.selectors) &&
    cached.selectors.length === pathLength
  );
}
async function executeNavigatePath(input) {
  const startedAt = nowMs();
  const absoluteDeadline = Date.now() + Math.max(1, input.timeoutMs || 60000);
  const profile = profileDocument(8);
  const sourceFramePath = input.sourceFramePath || [];
  const targetFramePath = input.targetFramePath || [];
  const rootSelector = input.rootSelector;
  const frameStartedAt = nowMs();
  let sourceDoc = resolveFrameDocument(sourceFramePath);
  const frameResolutionMs = elapsedMs(frameStartedAt);
  const initialTargetSignature = targetFramePath.length > 0
    ? documentSignature(resolveFrameDocument(targetFramePath))
    : undefined;
  const cached = input.cached;
  let cacheValid = cacheEntryMatches(cached, profile, input.path.length);
  let cacheInvalidated = Boolean(cached && !cacheValid);
  const resolvedLevels = [];
  const selectors = [];
  let locatorMs = 0;
  let interactionMs = 0;
  let navigationMs = 0;
  let candidateCount = 0;
  let retries = 0;
  for (let level = 0; level < input.path.length; level += 1) {
    const candidates = locatorCandidates(
      sourceDoc,
      sourceFramePath,
      { text: input.path[level] },
      rootSelector,
    );
    for (const candidate of candidates) {
      assertAuthorized(candidate.element, input.authorized, { kind: 'path', level });
    }
  }
  for (let level = 0; level < input.path.length; level += 1) {
    assertNotCancelled();
    if (Date.now() >= absoluteDeadline) {
      throw legacyError('NAVIGATION_TIMEOUT', 'Legacy navigation path exceeded its deadline.');
    }
    sourceDoc = resolveFrameDocument(sourceFramePath);
    let resolved;
    let usedCache = false;
    const locatorStartedAt = nowMs();
    try {
      if (cacheValid && cached.selectors[level]) {
        try {
          if (level > 0) {
            const cachedResolution = await resolvePathLocatorWithRetry(
              sourceDoc,
              sourceFramePath,
              { selector: cached.selectors[level] },
              rootSelector,
              Math.min(absoluteDeadline, Date.now() + 250),
            );
            resolved = cachedResolution.resolved;
            retries += cachedResolution.retries;
          } else {
            resolved = resolveLocator(
              sourceDoc,
              sourceFramePath,
              { selector: cached.selectors[level] },
              rootSelector,
            );
          }
          usedCache = true;
        } catch {
          cacheValid = false;
          cacheInvalidated = true;
          const fallback = await resolvePathLocatorWithRetry(
            sourceDoc,
            sourceFramePath,
            { text: input.path[level] },
            rootSelector,
            absoluteDeadline,
          );
          resolved = fallback.resolved;
          retries += fallback.retries;
        }
      } else {
        const located = await resolvePathLocatorWithRetry(
          sourceDoc,
          sourceFramePath,
          { text: input.path[level] },
          rootSelector,
          absoluteDeadline,
        );
        resolved = located.resolved;
        retries += located.retries;
      }
    } catch (error) {
      if (error && error.legacyCode) {
        throw legacyError(
          error.legacyCode,
          'Legacy path level ' + level + ' (' + compactText(input.path[level], 200) + '): ' + error.message,
        );
      }
      throw error;
    }
    locatorMs += elapsedMs(locatorStartedAt);
    candidateCount += resolved.candidateCount;
    assertAuthorized(resolved.element, input.authorized, { kind: 'path', level });
    const preserveExpandedState =
      level < input.path.length - 1 &&
      shouldPreserveExpandedPathState(
        sourceDoc,
        sourceFramePath,
        input.path[level],
        input.path[level + 1],
        rootSelector,
      );
    const interactionStartedAt = nowMs();
    if (!preserveExpandedState) {
      await cancellationCheckpoint();
      resolved.element.scrollIntoView({ block: 'center', inline: 'center' });
      const clickable = resolved.element.closest('a,button') || resolved.element;
      clickable.click();
    }
    interactionMs += elapsedMs(interactionStartedAt);
    selectors.push(resolved.item.selector);
    resolvedLevels.push({
      level,
      label: input.path[level],
      ref: resolved.item.ref,
      selector: resolved.item.selector,
      strategy: preserveExpandedState
        ? 'already-expanded'
        : usedCache ? 'cache-revalidated' : resolved.strategy,
    });
  }
  let destinationReady = targetFramePath.length === 0;
  if (targetFramePath.length > 0) {
    const navigationStartedAt = nowMs();
    while (Date.now() < absoluteDeadline) {
      const targetDoc = resolveFrameDocument(targetFramePath);
      const changed = documentSignature(targetDoc) !== initialTargetSignature;
      if (targetDoc.readyState !== 'loading' && changed) {
        destinationReady = true;
        break;
      }
      await delay(10);
    }
    navigationMs += elapsedMs(navigationStartedAt);
    if (!destinationReady) {
      throw legacyError('STATE_NOT_REACHED', 'Legacy destination frame did not change before the deadline.');
    }
  }
  return {
    completed: true,
    path: input.path,
    resolved: resolvedLevels,
    destinationReady,
    cache: {
      hit: cacheValid,
      revalidated: cacheValid,
      invalidated: cacheInvalidated,
    },
    telemetry: {
      totalMs: elapsedMs(startedAt),
      frameResolutionMs,
      locatorMs,
      interactionMs,
      navigationMs,
      candidateCount,
      cacheHit: cacheValid,
      cacheInvalidated,
      strategy: cacheValid ? 'cache-revalidated' : 'deterministic-locator',
      retries,
    },
    cacheEntry: {
      pageSignature: profile.pageSignature,
      frameGraphSignature: profile.frameGraphSignature,
      selectors,
    },
  };
}
async function executeLegacyOperation(operation, input) {
  const startedAt = nowMs();
  if (operation === 'preflightFrameStep') {
    const step = input.step || {};
    const framePath = step.framePath || [];
    const doc = resolveFrameDocument(framePath);
    if (step.action === 'press' && normalizeText(step.key) === 'enter' && !step.locator) {
      assertKeyboardAuthorized(step.authorized, { kind: 'step', index: 0 });
      return { navigationLikely: true };
    }
    let navigationLikely = false;
    let navigationTarget;
    if (step.action === 'click' || (step.action === 'press' && normalizeText(step.key) === 'enter')) {
      for (const candidate of locatorCandidates(doc, framePath, step.locator || {})) {
        assertAuthorized(candidate.element, step.authorized, { kind: 'step', index: 0 });
      }
      const resolved = resolveLocator(doc, framePath, step.locator || {});
      navigationLikely = isLikelyDocumentNavigation(resolved.element);
      navigationTarget = compactText(resolved.element.getAttribute('target'), 256);
    }
    return {
      navigationLikely,
      ...(navigationTarget ? { navigationTarget } : {}),
    };
  }
  if (operation === 'profilePage') {
    const result = profileDocument(input.maxDepth || 8);
    return { ...result, telemetry: { totalMs: elapsedMs(startedAt), frameResolutionMs: elapsedMs(startedAt), retries: 0 } };
  }
  if (operation === 'domIndex') {
    const frameStartedAt = nowMs();
    const framePath = input.framePath || [];
    const doc = resolveFrameDocument(framePath);
    const frameResolutionMs = elapsedMs(frameStartedAt);
    const indexStartedAt = nowMs();
    const indexed = indexDocument(doc, framePath, {
      rootSelector: input.rootSelector,
      query: input.query,
      offset: input.offset || 0,
      limit: input.limit || 500,
      visibleOnly: input.visibleOnly === true,
    });
    const indexMs = elapsedMs(indexStartedAt);
    const profile = profileDocument(8);
    return {
      framePath,
      pageSignature: profile.pageSignature,
      frameGraphSignature: profile.frameGraphSignature,
      ...indexed,
      telemetry: {
        totalMs: elapsedMs(startedAt),
        frameResolutionMs,
        indexMs,
        candidateCount: indexed.items.length,
        retries: 0,
      },
    };
  }
  if (operation === 'frameSequence') return executeFrameSequence(input);
  if (operation === 'focusForNativePress') return focusForNativePress(input);
  if (operation === 'navigatePath') return executeNavigatePath(input);
  throw legacyError('CAPABILITY_UNSUPPORTED', 'Unknown legacy browser operation.');
}
`;
