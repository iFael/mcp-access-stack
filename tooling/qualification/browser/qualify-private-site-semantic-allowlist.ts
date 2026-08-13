import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { Frame, Request, Response } from "playwright";
import { loadBrowserWorkerConfig } from "../../../services/browser-worker/config/browser-worker-config.js";
import { DirectPlaywrightDriver } from "../../../services/browser-worker/drivers/direct/direct-playwright-driver.js";
import { BrowserRuntime } from "../../../services/browser-worker/services/browser-runtime.js";
import {
  WindowsCredentialBrokerClient,
} from "../../../services/browser-worker/services/windows-credential-broker-client.js";
import {
  TRANSIENT_SEMANTIC_QUALIFICATION_CODES,
  retryTransientSemanticOperation,
} from "./semantic-allowlist-retry.mjs";

interface PrivateBrowserConfiguration {
  privateDirectory?: string;
}

interface SanitizedRoute {
  originKind: "private" | "external" | "denied";
  originHash?: string;
  method: string;
  path: string;
  queryKeys: string[];
  resourceType: string;
  navigation: boolean;
  frame: string;
  phase: string;
  status?: number;
  redirectedFromPath?: string;
}

interface FrameInventory {
  phase: string;
  frame: string;
  parentFrame?: string;
  document: SanitizedLocation;
  structure: {
    formCount: number;
    tableCount: number;
    iframeCount: number;
    interactiveCount: number;
    mutationControlCount: number;
    queryControlCount: number;
    unknownControlCount: number;
    fileInputCount: number;
    webFormsPostback: boolean;
    structureSha256: string;
  };
  forms: Array<{
    method: string;
    action: SanitizedLocation;
    target: string;
    fileInputCount: number;
    submitCategories: Record<string, number>;
    webFormsPostback: boolean;
  }>;
  routes: Array<{
    path: string;
    queryKeys: string[];
    target: string;
    category: string;
  }>;
}

interface SanitizedLocation {
  path: string;
  queryKeys: string[];
}

const ROOT = process.cwd();
const SITE_ID = "private-site";
const SITE_URL = new URL("https://dev-private.example.test/app");
const DENIED_ORIGIN = "https://private.example.test";
const PANEL_POSTBACK_RETRY_CODES = Object.freeze([
  "FRAME_NOT_FOUND",
  "FRAME_NOT_READY",
  "LOCATOR_NOT_FOUND",
  "STATE_NOT_REACHED",
]);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = new Date().toISOString();
const privateConfigPath = path.resolve(
  process.env.MCP_QUALIFICATION_PRIVATE_CONFIG ??
    path.join(ROOT, ".runtime-private", "docker", "production", "browser.json"),
);
const brokerPath = process.env.MCP_QUALIFICATION_BROKER_PATH;
if (!brokerPath || !path.isAbsolute(brokerPath)) {
  throw new Error("Qualification broker path is unavailable.");
}
const privateConfig = JSON.parse(
  await readFile(privateConfigPath, "utf8"),
) as PrivateBrowserConfiguration;
if (!privateConfig.privateDirectory) {
  throw new Error("Private Browser Worker directory is unavailable.");
}

const credentialPrivateDirectory = path.resolve(privateConfig.privateDirectory);
const publicQualificationRoot = path.join(
  ROOT,
  "runtime",
  "qualification",
  "browser-allowlist",
  runId,
);
const privateQualificationRoot = path.join(
  credentialPrivateDirectory,
  "qualification",
  "allowlist",
  runId,
);
const profileDirectory = path.join(privateQualificationRoot, "chrome-profile");
const runtimeDirectory = path.join(publicQualificationRoot, "runtime");
const reportDirectory = path.join(
  ROOT,
  "runtime",
  "qualification",
  "browser-allowlist",
  "reports",
  runId,
);
const reportPath = path.join(reportDirectory, "report.json");
const context: OperationContext = { ownerScope: `allowlist-qualification-${runId}` };
const routes: SanitizedRoute[] = [];
const requestRecords = new WeakMap<Request, SanitizedRoute>();
const frameInventories: FrameInventory[] = [];
const checkpoints: Array<{
  phase: string;
  passed: boolean;
  durationMs: number;
  errorCode?: string;
  retryCount?: number;
  retryCodes?: string[];
}> = [];
const retryEvidence = new Map<string, string[]>();
let phase = "startup";
let runtime: BrowserRuntime | undefined;
let driver: DirectPlaywrightDriver | undefined;
let taskId: string | undefined;
let taskFinished = false;
let runtimeShutdown = false;
let profileRemoved = false;
let runtimeRemoved = false;
let authenticationStatus: string | undefined;
let authenticationReason: string | undefined;
let runFailure: { phase: string; code: string } | undefined;

await mkdir(reportDirectory, { recursive: true });
try {
  const config = createConfig(runtimeDirectory, profileDirectory, brokerPath);
  driver = new DirectPlaywrightDriver(config);
  runtime = await BrowserRuntime.create(
    config,
    () => driver!,
    {
      credentialBroker: new WindowsCredentialBrokerClient({
        executablePath: brokerPath,
        privateDirectory: credentialPrivateDirectory,
        timeoutMs: 10_000,
      }),
    },
  );

  const opened = await openAuthorized(runtime, context);
  taskId = opened.taskId;
  authenticationStatus = opened.authenticationStatus;
  authenticationReason = opened.authenticationReason;
  if (!["performed", "session-reused"].includes(authenticationStatus)) {
    throw new AppError(
      "LOGIN_INTERACTION_REQUIRED",
      "LegacySite authentication did not reach an authenticated state.",
    );
  }
  const page = driver.activePage();
  page.context().on("request", (request) => recordRequest(request));
  page.context().on("response", (response) => recordResponse(response));

  await checkpoint("authenticated-shell-ready", async () => {
    phase = "authenticated-shell-loading";
    await waitForAuthenticatedMenu(runtime!, opened.tabId, context);
  });
  phase = "authenticated-shell";
  await inventoryFrames(page.frames(), phase);

  await checkpoint("open-cpx-finance", async () => {
    phase = "menu-navigation";
    await retryQualificationStep("open-cpx-finance", async () => {
      await waitForAuthenticatedMenu(runtime!, opened.tabId, context);
      await runtime!.navigatePath({
        tabId: opened.tabId,
        path: ["Financeiro", "CPX-Finance"],
        sourceFramePath: ["Menu"],
        targetFramePath: ["MenuContent"],
        segments: [{
          framePath: ["Menu"],
          path: ["Financeiro", "CPX-Finance"],
          targetFramePath: ["MenuContent"],
        }],
        timeoutMs: 30_000,
      }, context);
      await assertCpxReady(runtime!, opened.tabId, context);
    });
  });
  phase = "cpx-finance-ready";
  await inventoryFrames(page.frames(), phase);

  for (const panel of [
    { id: "conferencias", view: "CONFERENCIAS" },
    { id: "pendencias", view: "PENDENCIAS" },
    { id: "historico", view: "HISTORICO" },
  ]) {
    await checkpoint(`panel-${panel.id}`, async () => {
      phase = `panel-${panel.id}`;
      await selectPanel(
        runtime!,
        opened.tabId,
        context,
        panel.view,
        `panel-${panel.id}`,
      );
    });
    await inventoryFrames(page.frames(), phase);
  }

  await checkpoint("safe-refresh", async () => {
    phase = "safe-refresh";
    const dates = safeDateWindow(7);
    await selectPanel(
      runtime!,
      opened.tabId,
      context,
      "CONFERENCIAS",
      "safe-refresh",
    );
    await runtime!.frameSequence({
      tabId: opened.tabId,
      steps: [
        {
          action: "fill",
          framePath: ["MenuContent"],
          locator: { id: "IN2" },
          value: dates.startDate,
        },
        {
          action: "fill",
          framePath: ["MenuContent"],
          locator: { id: "IN3" },
          value: dates.endDate,
        },
        {
          action: "fill",
          framePath: ["MenuContent"],
          locator: { id: "IN5" },
          value: "20",
        },
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { selector: ".finc-fila-filter-refresh" },
        },
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: { selector: ".finc-fila-load-count" },
          state: "visible",
          timeoutMs: 30_000,
        },
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: { selector: ".finc-fila-table" },
          state: "visible",
          timeoutMs: 30_000,
        },
      ],
    }, context);
  });
  await inventoryFrames(page.frames(), phase);
} catch (error) {
  runFailure = {
    phase,
    code: error instanceof AppError ? error.code : "QUALIFICATION_ERROR",
  };
} finally {
  if (runtime && taskId) {
    await runtime.finishTask({ taskId }, context)
      .then(() => { taskFinished = true; })
      .catch(() => undefined);
  }
  if (runtime) {
    await runtime.shutdown()
      .then(() => { runtimeShutdown = true; })
      .catch(() => undefined);
  }
  profileRemoved = await removeWithRetry(privateQualificationRoot);
  runtimeRemoved = await removeWithRetry(publicQualificationRoot);
}

const privateRoutes = deduplicateRoutes(
  routes.filter((route) => route.originKind === "private"),
);
const externalRoutes = deduplicateRoutes(
  routes.filter((route) => route.originKind === "external"),
);
const deniedRoutes = routes.filter((route) => route.originKind === "denied");
const unexpectedMethods = privateRoutes.filter(
  (route) => !["GET", "HEAD", "POST"].includes(route.method),
);
const postRoutes = privateRoutes.filter((route) => route.method === "POST");
const observedRuleCandidates = privateRoutes.map((route) => ({
  method: route.method,
  path: route.path,
  queryKeys: route.queryKeys,
  resourceTypes: [route.resourceType],
  navigation: route.navigation,
  frames: [route.frame],
  phases: [route.phase],
}));
const mergedRuleCandidates = mergeRuleCandidates(observedRuleCandidates);
const unresolvedUnknownControls = frameInventories.reduce(
  (sum, inventory) => sum + inventory.structure.unknownControlCount,
  0,
);
const report = {
  schemaVersion: 1,
  runId,
  siteId: SITE_ID,
  startedAt,
  completedAt: new Date().toISOString(),
  passed: Boolean(
    runFailure === undefined &&
    ["performed", "session-reused"].includes(authenticationStatus ?? "") &&
    checkpoints.every((entry) => entry.passed) &&
    deniedRoutes.length === 0 &&
    unexpectedMethods.length === 0 &&
    taskFinished &&
    runtimeShutdown &&
    profileRemoved &&
    runtimeRemoved
  ),
  isolation: {
    productionRuntimeUsed: false,
    productionProfileUsed: false,
    productionProcessesChanged: false,
    isolatedProfile: true,
    isolatedRegistry: true,
  },
  credentialSafety: {
    credentialValuesObserved: false,
    requestHeadersCaptured: false,
    requestBodiesCaptured: false,
    responseBodiesCaptured: false,
    cookiesCaptured: false,
    tokensCaptured: false,
    screenshotsCaptured: false,
    traceEnabled: false,
    videoEnabled: false,
  },
  authentication: {
    status: authenticationStatus,
    ...(authenticationReason === undefined ? {} : { reason: authenticationReason }),
  },
  ...(runFailure === undefined ? {} : { failure: runFailure }),
  checkpoints,
  observed: {
    privateRequestCount: routes.filter((route) => route.originKind === "private").length,
    uniquePrivateRoutes: privateRoutes,
    uniqueExternalRoutes: externalRoutes,
    deniedRouteCount: deniedRoutes.length,
    postRouteCount: postRoutes.length,
    unexpectedMethods,
    frameInventories,
    unresolvedUnknownControls,
  },
  candidateAllowlist: {
    mode: "observed-read-only-query-flow",
    rules: mergedRuleCandidates,
  },
  retryPolicy: {
    transientCodes: [...TRANSIENT_SEMANTIC_QUALIFICATION_CODES],
    panelPostbackRetryCodes: [...PANEL_POSTBACK_RETRY_CODES],
    maximumAttemptsPerStep: 3,
    locatorConfidenceLowered: false,
    alternatePathsOrSelectorsAllowed: false,
    panelNavigationTimeoutRetried: false,
  },
  cleanup: {
    taskFinished,
    runtimeShutdown,
    profileRemoved,
    runtimeRemoved,
  },
};
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(JSON.stringify({
  passed: report.passed,
  reportPath: path.relative(ROOT, reportPath).replaceAll("\\", "/"),
  authentication: report.authentication,
  checkpoints,
  privateRequestCount: report.observed.privateRequestCount,
  uniquePrivateRouteCount: privateRoutes.length,
  postRouteCount: postRoutes.length,
  deniedRouteCount: deniedRoutes.length,
  unexpectedMethodCount: unexpectedMethods.length,
  candidateRuleCount: mergedRuleCandidates.length,
  unresolvedUnknownControls,
  cleanup: report.cleanup,
}, null, 2) + "\n");
process.exit(report.passed ? 0 : 1);

async function openAuthorized(
  activeRuntime: BrowserRuntime,
  activeContext: OperationContext,
): Promise<{ taskId: string; tabId: string; authenticationStatus: string; authenticationReason?: string }> {
  const pending = await activeRuntime.openAuthorizedSite({
    siteId: SITE_ID,
    purpose: "semantic-read-only-allowlist-qualification",
  }, activeContext);
  if (pending.status !== "confirmation_required") {
    throw new Error("Private-site confirmation was not produced.");
  }
  const opened = await activeRuntime.openAuthorizedSite({
    taskId: pending.taskId,
    siteId: SITE_ID,
    purpose: "semantic-read-only-allowlist-qualification",
    confirmationId: pending.confirmationId,
  }, activeContext);
  if (opened.status !== "opened") {
    throw new Error("LegacySite Dev did not open.");
  }
  return {
    taskId: opened.taskId,
    tabId: opened.tabId,
    authenticationStatus: opened.authentication.status,
    ...("reason" in opened.authentication
      ? { authenticationReason: opened.authentication.reason }
      : {}),
  };
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ")
    .trim();
}

async function assertCpxReady(
  activeRuntime: BrowserRuntime,
  tabId: string,
  activeContext: OperationContext,
): Promise<void> {
  await activeRuntime.frameSequence({
    tabId,
    steps: [
      {
        action: "waitFor",
        framePath: ["MenuContent"],
        locator: { selector: ".finc-fila-head" },
        state: "visible",
        timeoutMs: 30_000,
      },
      ...["IN2", "IN3", "IN4", "IN5"].map((id) => ({
        action: "assert" as const,
        framePath: ["MenuContent"],
        locator: { id },
        condition: "exists" as const,
      })),
    ],
  }, activeContext);
}

async function selectPanel(
  activeRuntime: BrowserRuntime,
  tabId: string,
  activeContext: OperationContext,
  view: string,
  checkpointName: string,
): Promise<void> {
  const buttonSelector = `button.finc-fila-view-tab[onclick*="'${view}'"]`;
  const activeSelector = `button.finc-fila-view-tab.is-active[onclick*="'${view}'"]`;

  await retryQualificationStep(checkpointName, async () => {
    await activeRuntime.frameSequence({
      tabId,
      steps: [
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: { selector: buttonSelector },
          state: "visible",
          timeoutMs: 10_000,
        },
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { selector: buttonSelector },
        },
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: { selector: activeSelector },
          state: "visible",
          timeoutMs: 20_000,
        },
      ],
    }, activeContext);
  }, PANEL_POSTBACK_RETRY_CODES);
}

async function checkpoint(name: string, operation: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  try {
    await operation();
    checkpoints.push({
      phase: name,
      passed: true,
      durationMs: round(performance.now() - startedAt),
      ...checkpointRetryEvidence(name),
    });
  } catch (error) {
    checkpoints.push({
      phase: name,
      passed: false,
      durationMs: round(performance.now() - startedAt),
      ...(error instanceof AppError ? { errorCode: error.code } : {}),
      ...checkpointRetryEvidence(name),
    });
    throw error;
  }
}

function checkpointRetryEvidence(name: string): { retryCount?: number; retryCodes?: string[] } {
  const codes = retryEvidence.get(name) ?? [];
  return codes.length === 0
    ? {}
    : { retryCount: codes.length, retryCodes: [...codes] };
}

async function retryQualificationStep(
  checkpointName: string,
  operation: () => Promise<void>,
  retryCodes: readonly string[] = TRANSIENT_SEMANTIC_QUALIFICATION_CODES,
): Promise<void> {
  await retryTransientSemanticOperation({
    operation,
    getErrorCode: (error: unknown) => error instanceof AppError ? error.code : undefined,
    maxAttempts: 3,
    delayMs: 500,
    retryCodes: [...retryCodes],
    onRetry: ({ code }: { code: string }) => {
      const codes = retryEvidence.get(checkpointName) ?? [];
      codes.push(code);
      retryEvidence.set(checkpointName, codes);
    },
  });
}

function recordRequest(request: Request): void {
  const location = classifyUrl(request.url());
  const route: SanitizedRoute = {
    ...location,
    method: request.method().toUpperCase(),
    resourceType: request.resourceType(),
    navigation: request.isNavigationRequest(),
    frame: safeFrameName(request.frame()),
    phase,
    ...(request.redirectedFrom()
      ? { redirectedFromPath: sanitizeUrl(request.redirectedFrom()!.url()).path }
      : {}),
  };
  routes.push(route);
  requestRecords.set(request, route);
}

function recordResponse(response: Response): void {
  const route = requestRecords.get(response.request());
  if (route) route.status = response.status();
}

function classifyUrl(value: string): Pick<SanitizedRoute, "originKind" | "originHash" | "path" | "queryKeys"> {
  const url = new URL(value);
  const sanitized = sanitizeUrl(value);
  if (url.origin === SITE_URL.origin) {
    return { originKind: "private", ...sanitized };
  }
  if (url.origin === DENIED_ORIGIN) {
    return { originKind: "denied", ...sanitized };
  }
  return {
    originKind: "external",
    originHash: sha256(url.origin).slice(0, 16),
    ...sanitized,
  };
}

function sanitizeUrl(value: string): SanitizedLocation {
  const url = new URL(value);
  return {
    path: normalizePathname(url.pathname),
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
  };
}

function normalizePathname(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d{4,}$/u.test(segment)) return ":number";
      if (/^[0-9a-f]{16,}$/iu.test(segment)) return ":opaque";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)) return ":uuid";
      return segment;
    })
    .join("/");
}

function safeFrameName(frame: Frame): string {
  const value = frame.name().trim();
  if (value) return value.slice(0, 120);
  return frame.parentFrame() ? "unnamed-child" : "top";
}

async function waitForAuthenticatedMenu(
  activeRuntime: BrowserRuntime,
  tabId: string,
  activeContext: OperationContext,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCode: string | undefined;
  let stablePasses = 0;
  while (Date.now() < deadline) {
    try {
      const [finance, cpx] = await Promise.all([
        activeRuntime.domIndex({
          tabId,
          framePath: ["Menu"],
          query: "Financeiro",
          offset: 0,
          limit: 50,
          visibleOnly: false,
        }, activeContext),
        activeRuntime.domIndex({
          tabId,
          framePath: ["Menu"],
          query: "CPX-Finance",
          offset: 0,
          limit: 20,
          visibleOnly: false,
        }, activeContext),
      ]);
      const financeReady = finance.items.some((item) =>
        normalizeLabel(item.text) === normalizeLabel("Financeiro")
      );
      const cpxReady = cpx.items.some((item) =>
        normalizeLabel(item.text) === normalizeLabel("CPX-Finance")
      );
      if (financeReady && cpxReady) {
        stablePasses += 1;
        if (stablePasses >= 2) return;
      } else {
        stablePasses = 0;
      }
    } catch (error) {
      stablePasses = 0;
      if (error instanceof AppError) {
        lastCode = error.code;
        if (![
          "FRAME_NOT_FOUND",
          "FRAME_NOT_READY",
          "LOCATOR_NOT_FOUND",
          "STATE_NOT_REACHED",
          "INTERNAL_ERROR",
        ].includes(error.code)) {
          throw error;
        }
      } else {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new AppError(
    "FRAME_NOT_READY",
    "Authenticated LegacySite menu did not become indexable before the deadline" + (lastCode ? " (last=" + lastCode + ")" : "") + ".",
  );
}

async function inventoryFrames(frames: Frame[], inventoryPhase: string): Promise<void> {
  for (const frame of frames) {
    if (!frame.url().startsWith("http")) continue;
    const raw = await frame.evaluate(sanitizedDomProbe()).catch(() => undefined) as
      | {
          formCount: number;
          tableCount: number;
          iframeCount: number;
          interactiveCount: number;
          mutationControlCount: number;
          queryControlCount: number;
          unknownControlCount: number;
          fileInputCount: number;
          webFormsPostback: boolean;
          forms: FrameInventory["forms"];
          routes: FrameInventory["routes"];
          structure: unknown;
        }
      | undefined;
    if (!raw) continue;
    frameInventories.push({
      phase: inventoryPhase,
      frame: safeFrameName(frame),
      ...(frame.parentFrame() ? { parentFrame: safeFrameName(frame.parentFrame()!) } : {}),
      document: sanitizeUrl(frame.url()),
      structure: {
        formCount: raw.formCount,
        tableCount: raw.tableCount,
        iframeCount: raw.iframeCount,
        interactiveCount: raw.interactiveCount,
        mutationControlCount: raw.mutationControlCount,
        queryControlCount: raw.queryControlCount,
        unknownControlCount: raw.unknownControlCount,
        fileInputCount: raw.fileInputCount,
        webFormsPostback: raw.webFormsPostback,
        structureSha256: sha256(JSON.stringify(raw.structure)),
      },
      forms: raw.forms.map((form) => ({
        ...form,
        action: sanitizeUrl(new URL(form.action.path, SITE_URL.origin).href +
          (form.action.queryKeys.length > 0
            ? `?${form.action.queryKeys.map((key) => `${encodeURIComponent(key)}=`).join("&")}`
            : "")),
      })),
      routes: raw.routes.map((route) => ({
        ...route,
        path: normalizePathname(route.path),
        queryKeys: [...new Set(route.queryKeys)].sort(),
      })),
    });
  }
}

function sanitizedDomProbe(): string {
  return `(() => {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ').trim();
  const mutation = /\\b(delete|remove|cancel|terminate|unsubscribe|deactivate|excluir|remover|cancelar|buy|purchase|pay|checkout|order|comprar|pagar|pagamento|send|message|email|enviar|publish|post|publicar|password|credential|security|senha|credencial|accept|agree|terms|contract|aceitar|concordo|upload|attach|anexar|submit|save|confirm|apply|create|update|salvar|confirmar)\\b/;
  const query = /\\b(refresh|reload|search|query|filter|view|history|conference|pending|atualizar|consultar|pesquisar|buscar|filtrar|historico|conferencia|pendencia|financeiro|cpx-finance|novidades|home)\\b/;
  const category = (element) => {
    const text = normalize([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('name'), element.id, element.className, element.textContent, element.value].join(' '));
    if (mutation.test(text)) return 'mutation';
    if (query.test(text)) return 'query';
    return 'unknown';
  };
  const locationOf = (value) => {
    try {
      const url = new URL(value || location.href, location.href);
      return { path: url.pathname, queryKeys: [...new Set([...url.searchParams.keys()])].sort() };
    } catch {
      return { path: '/', queryKeys: [] };
    }
  };
  const interactive = [...document.querySelectorAll('a[href],button,input[type=button],input[type=submit],input[type=image],select')]
    .filter((element) => !element.closest('table,[role=grid],.finc-fila-table'));
  const categories = interactive.map(category);
  const forms = [...document.forms].map((form) => {
    const submits = [...form.querySelectorAll('button,input[type=button],input[type=submit],input[type=image]')];
    const submitCategories = submits.reduce((result, element) => {
      const key = category(element);
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});
    return {
      method: String(form.method || 'GET').toUpperCase(),
      action: locationOf(form.action || location.href),
      target: String(form.target || '_self').slice(0, 120),
      fileInputCount: form.querySelectorAll('input[type=file]').length,
      submitCategories,
      webFormsPostback: Boolean(form.querySelector('[name=__VIEWSTATE],[name=__EVENTTARGET]')),
    };
  });
  const routes = [...document.querySelectorAll('a[href]')]
    .filter((element) => !element.closest('table,[role=grid],.finc-fila-table'))
    .map((element) => {
      const target = String(element.getAttribute('target') || '_self').slice(0, 120);
      const route = locationOf(element.href);
      return { ...route, target, category: category(element) };
    })
    .filter((entry, index, values) => values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index)
    .slice(0, 250);
  const structure = {
    tags: [...document.querySelectorAll('form,iframe,a,button,input,select,table')].map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      category: ['a','button','input','select'].includes(element.tagName.toLowerCase()) ? category(element) : '',
    })),
    formMethods: forms.map((form) => form.method),
    formActions: forms.map((form) => form.action),
  };
  return {
    formCount: document.forms.length,
    tableCount: document.querySelectorAll('table').length,
    iframeCount: document.querySelectorAll('iframe,frame').length,
    interactiveCount: interactive.length,
    mutationControlCount: categories.filter((value) => value === 'mutation').length,
    queryControlCount: categories.filter((value) => value === 'query').length,
    unknownControlCount: categories.filter((value) => value === 'unknown').length,
    fileInputCount: document.querySelectorAll('input[type=file]').length,
    webFormsPostback: Boolean(document.querySelector('[name=__VIEWSTATE],[name=__EVENTTARGET]')),
    forms,
    routes,
    structure,
  };
})()`;
}

function deduplicateRoutes(values: SanitizedRoute[]): SanitizedRoute[] {
  const result = new Map<string, SanitizedRoute>();
  for (const value of values) {
    const key = JSON.stringify({
      originKind: value.originKind,
      originHash: value.originHash,
      method: value.method,
      path: value.path,
      queryKeys: value.queryKeys,
      resourceType: value.resourceType,
      navigation: value.navigation,
      frame: value.frame,
      phase: value.phase,
      status: value.status,
      redirectedFromPath: value.redirectedFromPath,
    });
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()];
}

function mergeRuleCandidates(values: Array<{
  method: string;
  path: string;
  queryKeys: string[];
  resourceTypes: string[];
  navigation: boolean;
  frames: string[];
  phases: string[];
}>): typeof values {
  const result = new Map<string, (typeof values)[number]>();
  for (const value of values) {
    const key = JSON.stringify({
      method: value.method,
      path: value.path,
      queryKeys: value.queryKeys,
      navigation: value.navigation,
    });
    const current = result.get(key);
    if (!current) {
      result.set(key, {
        ...value,
        resourceTypes: [...new Set(value.resourceTypes)].sort(),
        frames: [...new Set(value.frames)].sort(),
        phases: [...new Set(value.phases)].sort(),
      });
      continue;
    }
    current.resourceTypes = [...new Set([...current.resourceTypes, ...value.resourceTypes])].sort();
    current.frames = [...new Set([...current.frames, ...value.frames])].sort();
    current.phases = [...new Set([...current.phases, ...value.phases])].sort();
  }
  return [...result.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.method.localeCompare(right.method)
  );
}

function safeDateWindow(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days - 1));
  const format = (date: Date): string =>
    [date.getDate(), date.getMonth() + 1, date.getFullYear()]
      .map((part, index) => index < 2 ? String(part).padStart(2, "0") : String(part))
      .join("/");
  return { startDate: format(start), endDate: format(end) };
}

function createConfig(
  isolatedRuntimeDirectory: string,
  isolatedProfileDirectory: string,
  credentialBrokerPath: string,
) {
  return loadBrowserWorkerConfig({
    BROWSER_WORKER_TOKEN: randomToken(),
    BROWSER_WORKER_MODE: "efficient",
    BROWSER_WORKER_PROFILE_MODE: "persistent",
    BROWSER_WORKER_BROWSER_CHANNEL: "chromium",
    BROWSER_WORKER_RUNTIME_DIR: isolatedRuntimeDirectory,
    BROWSER_WORKER_PRIVATE_DIR: path.dirname(isolatedProfileDirectory),
    BROWSER_WORKER_USER_DATA_DIR: isolatedProfileDirectory,
    BROWSER_WORKER_LEGACY_SITE_URL: SITE_URL.href,
    BROWSER_WORKER_CREDENTIAL_BROKER_PATH: credentialBrokerPath,
    BROWSER_WORKER_CONTEXT_IDLE_SHUTDOWN_MS: "0",
    BROWSER_TASK_REAPER_INTERVAL_MS: "60000",
    BROWSER_TASK_IDLE_TTL_MS: "600000",
    BROWSER_WORKER_CONNECT_TIMEOUT_MS: "90000",
    BROWSER_WORKER_OPERATION_TIMEOUT_MS: "120000",
    BROWSER_WORKER_ACTION_TIMEOUT_MS: "10000",
    BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "90000",
  });
}

function randomToken(): string {
  return createHash("sha256").update(`${runId}:${Math.random()}`).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function removeWithRetry(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return false;
}
