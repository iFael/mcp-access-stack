import {
  AppError,
  QUICK_OPERATION_TIMEOUT_MS,
  asAppError,
  browserDomIndexInputSchema,
  browserDomIndexResultSchema,
  browserFrameSequenceInputSchema,
  browserFrameSequenceResultSchema,
  browserNavigatePathInputSchema,
  browserNavigatePathResultSchema,
  sanitizeOperationDiagnostic,
  withToolOperationContext,
  type BrowserDomIndexInput,
  type BrowserExecutor,
  type BrowserFrameSequenceInput,
  type BrowserNavigatePathInput,
  type OperationContext,
  type ToolOperationContextFactory,
} from "@vs-code-gpt/shared";
import type { Response } from "express";
import type { ZodType } from "zod";
import {
  readBrowserWorkerClientTiming,
  type BrowserWorkerClientTiming,
} from "../browser/client.js";
import type { AuthenticatedRequest } from "../http/mcp-middleware.js";

interface LegacyFastPathAuth {
  requiredScope: string;
}

interface LegacyFastPathOptions {
  request: AuthenticatedRequest;
  response: Response;
  browser: BrowserExecutor | undefined;
  auth: LegacyFastPathAuth | undefined;
  operationContextFactory: ToolOperationContextFactory;
  requestSignal: AbortSignal;
}

interface LegacyFastPathDefinition {
  input: ZodType;
  output: ZodType;
  execute(
    browser: BrowserExecutor,
    input: unknown,
    context: OperationContext,
  ): Promise<unknown>;
}

interface LegacyFastPathTiming {
  requestToFastPathMs: number;
  dispatchMs: number;
  inputValidationMs: number;
  operationMs: number;
  outputValidationMs: number;
  serializationProbeMs: number;
  serverBeforeWriteMs: number;
  worker: BrowserWorkerClientTiming | null;
}

const ROUTE = "legacy-browser-fast-path-v1";
const TIMING_META_KEY = "com.openai.gateway/timing";
const ROUTE_META_KEY = "com.openai.gateway/route";

const definitions: Readonly<Record<string, LegacyFastPathDefinition>> = {
  browser_dom_index: {
    input: browserDomIndexInputSchema,
    output: browserDomIndexResultSchema,
    execute: (browser, input, context) =>
      browser.domIndex!(input as BrowserDomIndexInput, context),
  },
  browser_frame_sequence: {
    input: browserFrameSequenceInputSchema,
    output: browserFrameSequenceResultSchema,
    execute: (browser, input, context) =>
      browser.frameSequence!(input as BrowserFrameSequenceInput, context),
  },
  browser_navigate_path: {
    input: browserNavigatePathInputSchema,
    output: browserNavigatePathResultSchema,
    execute: (browser, input, context) =>
      browser.navigatePath!(input as BrowserNavigatePathInput, context),
  },
};

export async function tryHandleLegacyBrowserFastPath(
  options: LegacyFastPathOptions,
): Promise<boolean> {
  const fastPathEnteredAt = performance.now();
  const call = parseFastPathCall(options.request);
  if (!call || !options.browser) return false;
  const definition = definitions[call.name];
  if (!definition || !executorSupports(options.browser, call.name)) return false;
  if (
    options.auth &&
    !options.request.auth?.scopes.includes(options.auth.requiredScope)
  ) {
    return false;
  }
  const dispatchCompletedAt = performance.now();

  const inputValidationStartedAt = performance.now();
  const input = definition.input.safeParse(call.arguments);
  const inputValidationCompletedAt = performance.now();
  if (!input.success) return false;

  const operationStartedAt = performance.now();
  try {
    const executed = await withToolOperationContext(
      options.operationContextFactory,
      {
        signal: options.requestSignal,
        requestId: call.id,
      },
      QUICK_OPERATION_TIMEOUT_MS,
      (context) => definition.execute(options.browser!, input.data, context),
    );
    const operationCompletedAt = performance.now();
    const workerTiming = readBrowserWorkerClientTiming(executed) ?? null;

    const outputValidationStartedAt = performance.now();
    const output = workerTiming
      ? { success: true as const, data: executed }
      : definition.output.safeParse(executed);
    const outputValidationCompletedAt = performance.now();
    if (!output.success) {
      writeJsonRpcError(
        options.response,
        call.id,
        -32602,
        `Output validation error: Invalid structured content for tool ${call.name}.`,
      );
      return true;
    }

    sendCallResult(
      options,
      call.id,
      {
        content: [{
          type: "text",
          text: summarizeResult(call.name, output.data),
        }],
        structuredContent: output.data,
      },
      buildTiming({
        options,
        fastPathEnteredAt,
        dispatchCompletedAt,
        inputValidationStartedAt,
        inputValidationCompletedAt,
        operationStartedAt,
        operationCompletedAt,
        outputValidationStartedAt,
        outputValidationCompletedAt,
        workerTiming,
      }),
    );
    return true;
  } catch (error) {
    const operationCompletedAt = performance.now();
    const appError = error instanceof AppError ? error : asAppError(error);
    const lifecycle = appError.lifecycle;
    const diagnostic = lifecycle
      ? `; reason=${lifecycle.reason ?? "unknown"}; layer=${lifecycle.terminatedBy ?? "unknown"}; elapsedMs=${lifecycle.elapsedMs}`
      : "";
    sendCallResult(
      options,
      call.id,
      {
        isError: true,
        content: [{
          type: "text",
          text: sanitizeOperationDiagnostic(
            `${appError.code}: ${appError.message}${diagnostic}`,
          ),
        }],
      },
      buildTiming({
        options,
        fastPathEnteredAt,
        dispatchCompletedAt,
        inputValidationStartedAt,
        inputValidationCompletedAt,
        operationStartedAt,
        operationCompletedAt,
        outputValidationStartedAt: operationCompletedAt,
        outputValidationCompletedAt: operationCompletedAt,
        workerTiming: readBrowserWorkerClientTiming(error) ?? null,
      }),
    );
    return true;
  }
}

function buildTiming(input: {
  options: LegacyFastPathOptions;
  fastPathEnteredAt: number;
  dispatchCompletedAt: number;
  inputValidationStartedAt: number;
  inputValidationCompletedAt: number;
  operationStartedAt: number;
  operationCompletedAt: number;
  outputValidationStartedAt: number;
  outputValidationCompletedAt: number;
  workerTiming: BrowserWorkerClientTiming | null;
}): Omit<LegacyFastPathTiming, "serializationProbeMs" | "serverBeforeWriteMs"> {
  const requestStartedAt =
    input.options.request.mcpRequestStartedAt ?? input.fastPathEnteredAt;
  return {
    requestToFastPathMs: roundTiming(input.fastPathEnteredAt - requestStartedAt),
    dispatchMs: roundTiming(input.dispatchCompletedAt - input.fastPathEnteredAt),
    inputValidationMs: roundTiming(
      input.inputValidationCompletedAt - input.inputValidationStartedAt,
    ),
    operationMs: roundTiming(
      input.operationCompletedAt - input.operationStartedAt,
    ),
    outputValidationMs: roundTiming(
      input.outputValidationCompletedAt - input.outputValidationStartedAt,
    ),
    worker: input.workerTiming,
  };
}

function sendCallResult(
  options: LegacyFastPathOptions,
  id: string | number,
  result: Record<string, unknown>,
  baseTiming: Omit<LegacyFastPathTiming, "serializationProbeMs" | "serverBeforeWriteMs">,
): void {
  const routeMeta = { [ROUTE_META_KEY]: ROUTE };
  if (!options.request.mcpBenchmarkTiming) {
    writeJsonBody(options.response, {
      jsonrpc: "2.0",
      id,
      result: {
        ...result,
        _meta: routeMeta,
      },
    });
    return;
  }

  const requestStartedAt = options.request.mcpRequestStartedAt ?? performance.now();
  const probePayload = {
    jsonrpc: "2.0",
    id,
    result: {
      ...result,
      _meta: {
        ...routeMeta,
        [TIMING_META_KEY]: {
          ...baseTiming,
          serializationProbeMs: 0,
          serverBeforeWriteMs: 0,
        },
      },
    },
  };
  const serializationStartedAt = performance.now();
  JSON.stringify(probePayload);
  const serializationProbeMs = roundTiming(
    performance.now() - serializationStartedAt,
  );
  const timing: LegacyFastPathTiming = {
    ...baseTiming,
    serializationProbeMs,
    serverBeforeWriteMs: roundTiming(performance.now() - requestStartedAt),
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      ...result,
      _meta: {
        ...routeMeta,
        [TIMING_META_KEY]: timing,
      },
    },
  });
  writeSerializedJson(options.response, body);
}

function parseFastPathCall(request: AuthenticatedRequest): {
  id: string | number;
  name: string;
  arguments: unknown;
} | undefined {
  if (!request.header("mcp-protocol-version")) return undefined;
  const body = request.body;
  if (!isRecord(body) || body.jsonrpc !== "2.0" || body.method !== "tools/call") {
    return undefined;
  }
  if (typeof body.id !== "string" && typeof body.id !== "number") {
    return undefined;
  }
  if (!isRecord(body.params) || typeof body.params.name !== "string") {
    return undefined;
  }
  return {
    id: body.id,
    name: body.params.name,
    arguments: body.params.arguments ?? {},
  };
}

function executorSupports(browser: BrowserExecutor, name: string): boolean {
  switch (name) {
    case "browser_dom_index": return typeof browser.domIndex === "function";
    case "browser_frame_sequence": return typeof browser.frameSequence === "function";
    case "browser_navigate_path": return typeof browser.navigatePath === "function";
    default: return false;
  }
}

function summarizeResult(name: string, value: unknown): string {
  const result = isRecord(value) ? value : {};
  return "tabId" in result
    ? `tabId=${String(result.tabId)}`
    : `${name} completed.`;
}

function writeJsonRpcError(
  response: Response,
  id: string | number,
  code: number,
  message: string,
): void {
  writeJsonBody(response, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function writeJsonBody(response: Response, value: unknown): void {
  writeSerializedJson(response, JSON.stringify(value));
}

function writeSerializedJson(response: Response, body: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function roundTiming(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
