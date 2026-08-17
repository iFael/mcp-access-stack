import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  remainingOperationTimeMs,
  type BrowserActionResult,
  type BrowserClickInput,
  type BrowserCloseTabInput,
  type BrowserConnectInput,
  type BrowserConnectResult,
  type BrowserContextRecoveryMetrics,
  type BrowserConsoleInput,
  type BrowserConsoleResult,
  type BrowserDiagnosticsInput,
  type BrowserDiagnosticsResult,
  type BrowserDownloadInput,
  type BrowserDownloadResult,
  type BrowserUploadInput,
  type BrowserUploadResult,
  type BrowserExecutor,
  type BrowserExtractInput,
  type BrowserExtractResult,
  type BrowserFillInput,
  type BrowserFinishTaskInput,
  type BrowserFinishTaskResult,
  type BrowserFrameClickInput,
  type BrowserFrameExtractInput,
  type BrowserFrameExtractResult,
  type BrowserFrameFillInput,
  type BrowserDomIndexInput,
  type BrowserDomIndexResult,
  type BrowserFrameSequenceInput,
  type BrowserFrameSequenceResult,
  type BrowserNavigatePathInput,
  type BrowserNavigatePathResult,
  type BrowserProfilePageInput,
  type BrowserProfilePageResult,
  type BrowserNavigateInput,
  type BrowserNetworkInspectInput,
  type BrowserNetworkListInput,
  type BrowserNetworkResult,
  type BrowserOpenInput,
  type BrowserOpenAuthorizedSiteInput,
  type BrowserOpenAuthorizedSiteResult,
  type BrowserPdfInput,
  type BrowserPdfResult,
  type BrowserPressInput,
  type BrowserScreenshotInput,
  type BrowserScreenshotResult,
  type BrowserSequenceInput,
  type BrowserSequenceResult,
  type BrowserSnapshotInput,
  type BrowserSnapshotResult,
  type BrowserStatusInput,
  type BrowserStatusResult,
  type BrowserStateUpdate,
  type BrowserOperation,
  type BrowserOperationTiming,
  type BrowserTab,
  type BrowserTraceInput,
  type BrowserTraceStartResult,
  type BrowserTraceStopResult,
  type BrowserTabActionInput,
  type BrowserTabResult,
  type BrowserTabsInput,
  type BrowserTabsResult,
  type BrowserVideoStartInput,
  type BrowserVideoStartResult,
  type BrowserVideoStopInput,
  type BrowserVideoStopResult,
  type BrowserWaitInput,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { isBrowserAdvancedDriver } from "../drivers/browser-advanced-driver.js";
import type { BrowserOperationTelemetry } from "../infrastructure/browser-operation-telemetry.js";
import {
  BrowserConfirmationRegistry,
  type BrowserConfirmationBinding,
} from "../domain/confirmation-registry.js";
import {
  resolveBrowserOperationMode,
  type BrowserOperationMode,
} from "../policies/browser-operation-mode.js";
import {
  assertBrowserOperationAllowed,
  type BrowserAdvancedOperation,
} from "../policies/browser-operation-policy.js";
import {
  unavailableAdvancedReadiness,
  type BrowserAdvancedCapabilityAvailability,
  type BrowserWorkerReadiness,
} from "./browser-readiness.js";
import type { BrowserWorkerConfig } from "../config/browser-worker-config.js";
import type {
  BrowserDriver,
  BrowserDriverFactory,
  BrowserDriverResponse,
  BrowserDriverTab,
} from "../drivers/browser-driver.js";
import { BrowserDiagnosticService } from "./browser-diagnostic-service.js";
import { BrowserTabBindingService } from "./browser-tab-binding-service.js";
import { BrowserTabSelectionService } from "./browser-tab-selection-service.js";
import { BrowserSessionStateService } from "./browser-session-state-service.js";
import { BrowserNavigationStateService } from "./browser-navigation-state-service.js";
import { BrowserInteractionContextService } from "./browser-interaction-context-service.js";
import { BrowserPageReadService } from "./browser-page-read-service.js";
import {
  BrowserExtractionCompletenessService,
  type BrowserCompletedExtraction,
} from "./browser-extraction-completeness-service.js";
import { BrowserPersistentTabService } from "./browser-persistent-tab-service.js";
import { BrowserConnectionBootstrapService } from "./browser-connection-bootstrap-service.js";
import { BrowserFrameOperationService } from "./browser-frame-operation-service.js";
import { BrowserLegacyAutomationService } from "./browser-legacy-automation-service.js";
import { BrowserFileTransferService } from "./browser-file-transfer-service.js";
import {
  applyBrowserSessionRouting,
  createBrowserSession,
  toPublicBrowserTab,
  touchBrowserSession,
  type BrowserSession,
  type UnifiedBrowserTab,
} from "../domain/browser-session-model.js";
import { NavigationCache, type NavigationCacheLookup } from "../domain/navigation-cache.js";
import {
  DirectPlaywrightDriver,
  isDirectPlaywrightDriver,
} from "../drivers/direct/direct-playwright-driver.js";
import {
  BrowserSessionRegistry,
  type BrowserNavigationTransition,
  type BrowserTabBinding,
} from "../domain/session-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";
import {
  normalizeBrowserUrl as normalizeUrl,
  selectExactTabReuse,
  selectRecyclableTab,
} from "../domain/browser-tab-reuse.js";
import {
  BrowserTaskRegistry,
  type BrowserTask,
  type BrowserTaskLease,
} from "../domain/browser-task-registry.js";
import {
  BrowserSitePolicyRegistry,
  isAuthorizedSiteSemanticActionAllowed,
  type AuthorizedSitePolicy,
  type AuthorizedSiteSemanticActionDescriptor,
} from "../domain/authorized-site-policy.js";
import {
  BrowserSiteGrantRegistry,
  type BrowserSiteGrant,
} from "../domain/browser-site-grant-registry.js";
import {
  BrowserSiteAuthenticationService,
  type BrowserSiteAuthenticationOutcome,
} from "./browser-site-authentication-service.js";
import { FileCredentialBroker } from "./file-credential-broker.js";
import {
  WindowsCredentialBrokerClient,
  type BrowserCredentialBroker,
} from "./windows-credential-broker-client.js";


const PAGE_STABILIZATION_MAX_MS = 2_000;

interface BrowserEngineSelection {
  reason: string;
  policyReason: string;
}

export interface BrowserRuntimeDependencies {
  credentialBroker?: BrowserCredentialBroker;
  telemetry?: BrowserOperationTelemetry;
}

export class BrowserRuntime implements BrowserExecutor {
  private state: "disconnected" | "connecting" | "connected" = "disconnected";
  private disconnectedReady = true;
  private readonly bindings = new Map<string, BrowserTabBinding>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly unifiedTabs = new Map<string, UnifiedBrowserTab>();
  private readonly interactionContext: BrowserInteractionContextService;
  private readonly pageRead: BrowserPageReadService;
  private readonly persistentTabs: BrowserPersistentTabService;
  private readonly connectionBootstrap: BrowserConnectionBootstrapService;
  private readonly frameOperations: BrowserFrameOperationService;
  private readonly legacyAutomation: BrowserLegacyAutomationService;
  private readonly confirmations = new BrowserConfirmationRegistry();
  private readonly authenticatedSiteKeys = new Set<string>();
  private readonly tabBindings: BrowserTabBindingService;
  private readonly sessionState: BrowserSessionStateService;
  private readonly navigationState: BrowserNavigationStateService;
  private readonly tabSelection: BrowserTabSelectionService;
  private readonly advancedDiagnostics: BrowserDiagnosticService;
  private readonly fileTransfers: BrowserFileTransferService;
  private readonly taskRegistry: BrowserTaskRegistry;
  private readonly sitePolicies: BrowserSitePolicyRegistry;
  private readonly siteGrants = new BrowserSiteGrantRegistry();
  private readonly siteAuthentication: BrowserSiteAuthenticationService;
  private connectionTaskId: string | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly activeTraceTasks = new Set<string>();
  private readonly activeVideoTasks = new Set<string>();
  private readonly credentialActiveTabs = new Set<string>();
  private taskReaperTimer: ReturnType<typeof setInterval> | undefined;
  private contextIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private connectPromise: Promise<void> | undefined;
  private recoveryInProgress = false;
  private recoveryRequired = false;
  private readonly recoveryMetrics: BrowserContextRecoveryMetrics = {
    zeroPageDetections: 0,
    contextRecoveriesAttempted: 0,
    contextRecoveriesSucceeded: 0,
    contextRecoveriesFailed: 0,
    pagesRecreated: 0,
    contextsRestarted: 0,
    staleBindingsRemoved: 0,
    staleReferencesRemoved: 0,
    recoveryContentionCount: 0,
    recoveryDurationMs: 0,
  };
  private shutdownRequested = false;

  private constructor(
    private readonly config: BrowserWorkerConfig,
    private readonly telemetry: BrowserOperationTelemetry | undefined,
    private readonly tabsRegistry: TabRegistry,
    sessionRegistry: BrowserSessionRegistry,
    private readonly navigationCache: NavigationCache,
    private readonly driver: BrowserDriver,
    private session: BrowserSession,
    persistedSessions: readonly BrowserSession[],
    persistedTabs: readonly UnifiedBrowserTab[],
    persistedTasks: readonly BrowserTask[],
    credentialBroker: BrowserCredentialBroker,
  ) {
    this.taskRegistry = new BrowserTaskRegistry(
      persistedTasks,
      config.taskIdleTtlMs ?? 10 * 60 * 1000,
    );
    this.sitePolicies = new BrowserSitePolicyRegistry(config.privateSitePolicies ?? []);
    this.siteAuthentication = new BrowserSiteAuthenticationService(
      driver,
      credentialBroker,
      {
        loginTimeoutMs: config.loginTimeoutMs ?? 30_000,
        invalidCredentialBackoffMs: config.loginInvalidBackoffMs ?? 5 * 60 * 1000,
      },
    );
    this.tabBindings = new BrowserTabBindingService({
      driverKind: driver.kind,
      tabsRegistry,
      bindings: this.bindings,
      unifiedTabs: this.unifiedTabs,
      getSession: () => this.session,
      setSession: (session) => {
        this.session = session;
      },
      normalizeUrl,
    });
    this.interactionContext = new BrowserInteractionContextService();
    this.sessionState = new BrowserSessionStateService({
      tabsRegistry,
      sessionStore: sessionRegistry,
      sessions: this.sessions,
      unifiedTabs: this.unifiedTabs,
      bindings: this.bindings,
      taskRegistry: this.taskRegistry,
      getSession: () => this.session,
      setSession: (session) => {
        this.session = session;
      },
      isActiveBinding: (binding) => this.tabBindings.isActive(binding),
      discardReferences: (tabId) => this.interactionContext.discardReferences(tabId),
      clearReferences: () => this.interactionContext.clearReferences(),
      clearConfirmations: () => this.confirmations.clear(),
    });
    this.navigationState = new BrowserNavigationStateService({
      navigationTimeoutMs: config.navigationTimeoutMs,
      tabsRegistry,
      bindings: this.bindings,
      tabBindings: this.tabBindings,
      normalizeUrl,
    });
    this.pageRead = new BrowserPageReadService({
      driver,
      interactionContext: this.interactionContext,
      updateSelectedTab: (tabId, response, fallbackUrl) =>
        this.updateSelectedTab(tabId, response, fallbackUrl),
      actionTimeoutMs: config.actionTimeoutMs,
    });
    this.frameOperations = new BrowserFrameOperationService({
      driver: driver as DirectPlaywrightDriver,
    });
    this.legacyAutomation = new BrowserLegacyAutomationService({
      driver: driver as DirectPlaywrightDriver,
    });
    this.tabSelection = new BrowserTabSelectionService({
      driver,
      tabsRegistry,
      bindings: this.bindings,
      tabBindings: this.tabBindings,
      ensureConnection: () => this.ensureConnection(),
      checkpoint: () => this.checkpoint(),
      discardOrphan: (tabId) => this.sessionState.discardTaskTab(tabId),
    });
    this.persistentTabs = new BrowserPersistentTabService({
      driver,
      tabsRegistry,
      bindings: this.bindings,
      tabBindings: this.tabBindings,
      tabSelection: this.tabSelection,
      ...(config.primaryPrivateSiteUrl
        ? {
            primaryPrivateSite: {
              url: config.primaryPrivateSiteUrl.href,
              siteId: config.primaryPrivateSiteId ?? "private-site",
            },
          }
        : {}),
      normalizeUrl,
      resolveRestoreTarget: (tab, targetUrl) =>
        this.resolvePersistentRestoreTarget(tab, targetUrl),
    });
    this.connectionBootstrap = new BrowserConnectionBootstrapService({
      driver,
      adoptExistingTabs: false,
      defaultTaskId: () => this.requireConnectionTaskId(),
      tabsRegistry,
      tabBindings: this.tabBindings,
      tabSelection: this.tabSelection,
      persistentTabs: this.persistentTabs,
    });
    this.advancedDiagnostics = new BrowserDiagnosticService(driver);
    this.fileTransfers = new BrowserFileTransferService(
      config.privateDirectory,
      driver as DirectPlaywrightDriver,
    );
    this.sessionState.hydrate(persistedSessions, persistedTabs);
    this.startTaskReaper();
  }

  static async create(
    config: BrowserWorkerConfig,
    driverFactory?: BrowserDriverFactory,
    dependencies: BrowserRuntimeDependencies = {},
  ): Promise<BrowserRuntime> {
    const sessionRegistry = new BrowserSessionRegistry(config.runtimeDirectory);
    const [persisted, navigationCache] = await Promise.all([
      sessionRegistry.load(),
      NavigationCache.load(config.runtimeDirectory, {
        maxEntries: config.navigationCacheMaxEntries ?? 100,
        retentionMs: config.navigationCacheRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
      }),
    ]);

    let driver: BrowserDriver;
    let decision: BrowserEngineSelection;
    const mode: BrowserOperationMode = config.mode;

    if (driverFactory) {
      driver = driverFactory(config);
      decision = {
        reason: "injected-driver",
        policyReason: "test-or-embedded-driver-injection",
      };
    } else {
      driver = new DirectPlaywrightDriver(config);
      decision = {
        reason: "direct-engine-default",
        policyReason: "direct-engine-default",
      };
    }

    const session = selectRuntimeSession(
      persisted.sessions,
      driver.kind,
      mode,
      decision,
      config,
    );
    const activeTabs = persisted.tabs
      .filter(
        (tab) => tab.sessionId === session.sessionId && tab.driver === driver.kind,
      )
      .map(toPublicBrowserTab);
    const credentialBroker = dependencies.credentialBroker ??
      (config.credentialsPath
        ? new FileCredentialBroker(config.credentialsPath)
        : new WindowsCredentialBrokerClient({
            ...(config.credentialBrokerPath === undefined
              ? {}
              : { executablePath: config.credentialBrokerPath }),
            privateDirectory: config.privateDirectory,
            timeoutMs: config.credentialBrokerTimeoutMs ?? 10_000,
          }));
    const runtime = new BrowserRuntime(
      config,
      dependencies.telemetry,
      new TabRegistry(activeTabs),
      sessionRegistry,
      navigationCache,
      driver,
      session,
      persisted.sessions,
      persisted.tabs,
      persisted.tasks,
      credentialBroker,
    );
    for (const binding of persisted.bindings) {
      runtime.bindings.set(binding.tabId, binding);
    }
    return runtime;
  }

  isReady(): boolean {
    return (
      this.state === "connected" &&
      this.driver.isConnected() &&
      this.driverHasUsablePage()
    );
  }

  async readiness(): Promise<BrowserWorkerReadiness> {
    const connected = this.isReady();
    const idle = !this.shutdownRequested && this.state === "disconnected" && this.disconnectedReady;
    const ready = connected || idle;
    const profile = resolveBrowserOperationMode(this.session.mode);
    const advancedDriver = isBrowserAdvancedDriver(this.driver)
      ? this.driver
      : undefined;
    const advanced = advancedDriver?.getAdvancedReadiness
      ? await advancedDriver.getAdvancedReadiness().catch(() =>
          unavailableAdvancedReadiness(),
        )
      : unavailableAdvancedReadiness();
    const modeAllowsAdvanced = profile.allowAdvancedOperations;
    const advancedEnabled = connected && modeAllowsAdvanced && advancedDriver !== undefined;
    const capabilities: BrowserAdvancedCapabilityAvailability = {
      console: advancedEnabled,
      network: advancedEnabled,
      trace: advancedEnabled,
      video: advancedEnabled && advanced.ffmpegAvailable,
      pdf: advancedEnabled,
      diagnostics: advancedEnabled,
    };
    const advancedCapabilitiesAvailable =
      capabilities.console &&
      capabilities.network &&
      capabilities.trace &&
      capabilities.pdf &&
      capabilities.diagnostics;
    const degraded = !connected && (
      this.state === "connected" && this.driver.isConnected()
    );
    return {
      status: connected ? "ready" : idle ? "idle" : degraded ? "degraded" : "disconnected",
      ready,
      connected,
      mode: this.session.mode,
      driver: this.driver.kind,
      advancedCapabilitiesAvailable,
      capabilities,
      ffmpegAvailable: advanced.ffmpegAvailable,
      activeTraces: advanced.activeTraces,
      activeVideos: advanced.activeVideos,
      artifactStorageBytes: advanced.artifactStorageBytes,
      artifactCount: advanced.artifactCount,
    };
  }

  async status(_input: BrowserStatusInput): Promise<BrowserStatusResult> {
    if (this.state === "connected" && !this.driver.isConnected()) {
      this.recoveryRequired = true;
      this.disconnectedReady = false;
      this.state = "disconnected";
      this.sessionState.transition("disconnected");
    }
    const engineStatus = isDirectPlaywrightDriver(this.driver)
      ? this.driver.engineStatus()
      : undefined;
    return {
      state: this.state,
      ready: this.isReady(),
      browser: "chrome",
      profile: isDirectPlaywrightDriver(this.driver)
        ? "dedicated-persistent"
        : this.config.profileMode === "persistent"
          ? "dedicated-persistent"
          : "default",
      autoLaunch: true,
      tabGroup: "MCP",
      edgeFallback: "technical-necessity-only",
      tabCount: this.tabsRegistry.list().length,
      taskCount: this.taskRegistry.snapshot().filter((task) =>
        task.state === "active" || task.state === "suspended",
      ).length,
      recovery: { ...this.recoveryMetrics },
      ...(engineStatus
        ? {
            engine: engineStatus.engine,
            engineVersion: engineStatus.engineVersion,
            protocolVersion: engineStatus.protocolVersion,
            playwrightVersion: engineStatus.playwrightVersion,
            browserChannel: engineStatus.browserChannel,
            chromiumRevision: engineStatus.chromiumRevision,
            capabilities: {
              semanticSnapshots: true,
              incrementalSnapshots: engineStatus.incrementalSnapshots,
              actionState: true,
              perTabConcurrency: true,
              zeroPageRecovery: true,
              taskLifecycle: true,
            },
          }
        : {}),
    };
  }

  async connect(
    _input: BrowserConnectInput,
    context: OperationContext = {},
  ): Promise<BrowserConnectResult> {
    const task = this.taskRegistry.resolveForOpen(undefined, context);
    return this.withTaskLease(task.taskId, context, async () => {
      this.cancelContextIdleShutdown();
      await this.ensureConnection(task.taskId);
      await this.checkpoint();
      return this.status({});
    });
  }

  async tabs(
    input: BrowserTabsInput,
    context: OperationContext = {},
  ): Promise<BrowserTabsResult> {
    const task = this.taskRegistry.resolveForOpen(input.taskId, context);
    return this.withTaskLease(task.taskId, context, async () => {
      this.cancelContextIdleShutdown();
      await this.ensureConnection(task.taskId);
      await this.reconcileBindings(true);
      await this.checkpoint();
      const tabIds = new Set(
        this.taskRegistry.resolveScoped(task.taskId, context).tabIds,
      );
      return {
        tabs: this.tabsRegistry.list().filter((tab) => tabIds.has(tab.tabId)),
      };
    });
  }

  async openAuthorizedSite(
    input: BrowserOpenAuthorizedSiteInput,
    context: OperationContext = {},
  ): Promise<BrowserOpenAuthorizedSiteResult> {
    const policy = this.sitePolicies.require(input.siteId);
    const task = this.taskRegistry.resolveForOpen(input.taskId, context);
    if (!input.confirmationId) {
      const pending = this.siteGrants.createConfirmation(
        task,
        policy,
        input.purpose,
      );
      await this.checkpoint();
      return {
        status: "confirmation_required",
        taskId: task.taskId,
        siteId: policy.siteId,
        confirmationId: pending.confirmationId,
        expiresAt: pending.expiresAt,
        reasons: [
          "Allow this task to access private site " +
            policy.siteId +
            " in " +
            policy.accessMode +
            " mode.",
        ],
      };
    }

    return this.withTaskLease(task.taskId, context, async () => {
      const grant = this.siteGrants.confirm(
        input.confirmationId!,
        task,
        policy,
        input.purpose,
      );
      this.syncPrivateOriginActivation();
      if (policy.loginStrategy === "none") {
        this.authenticatedSiteKeys.add(authenticatedSiteKey(task.taskId, policy.siteId));
      }
      try {
        const opened = await this.open({
          taskId: task.taskId,
          url: policy.entryUrl,
          purpose: policy.siteId,
          reusable: false,
          protected: true,
          sticky: true,
        }, context);
        const authentication = await this.authenticateAuthorizedSite(
          policy,
          task.taskId,
          opened.tab.tabId,
          context,
        );
        if (["performed", "session-reused", "not-required"].includes(authentication.status)) {
          this.authenticatedSiteKeys.add(authenticatedSiteKey(task.taskId, policy.siteId));
          this.applyActivePageGrant(grant);
        }
        if (authentication.status === "performed") {
          await this.reconcileBindings(true);
          await this.checkpoint();
        }
        return {
          status: "opened",
          taskId: task.taskId,
          tabId: opened.tab.tabId,
          authorization: {
            status: "granted",
            expiresAt: grant.expiresAt,
          },
          authentication,
          site: {
            siteId: policy.siteId,
            accessMode: policy.accessMode,
          },
          ...(opened.state === undefined || authentication.status === "performed"
            ? {}
            : { state: opened.state }),
          ...(opened.timing === undefined ? {} : { timing: opened.timing }),
        };
      } catch (error) {
        this.authenticatedSiteKeys.delete(authenticatedSiteKey(task.taskId, policy.siteId));
        this.siteGrants.revokeTaskSite(task.taskId, policy.siteId);
        this.syncPrivateOriginActivation();
        throw error;
      }
    });
  }

  async open(
    input: BrowserOpenInput,
    context: OperationContext = {},
  ): Promise<BrowserTabResult> {
    const task = this.taskRegistry.resolveForOpen(input.taskId, context);
    return this.withTaskLease(task.taskId, context, async () => {
      this.cancelContextIdleShutdown();
      this.connectionTaskId = task.taskId;
      await this.ensureConnection(task.taskId);
      const actionStarted = performance.now();
      if (input.sticky && !input.url) {
        throw new AppError("INVALID_ARGUMENT", "A sticky tab requires a locked URL.");
      }
      const cached = input.url === undefined && input.purpose !== undefined
        ? this.navigationCache.resolve(input.purpose)
        : undefined;
      const cacheState = input.url === undefined && input.purpose !== undefined
        ? (cached === undefined ? "miss" : "hit")
        : "not_applicable";
      const targetUrl = normalizeUrl(input.url ?? cached?.entry.url ?? "about:blank");
      const targetGrant = this.requireTargetGrant(task, targetUrl);
      const primaryPrivateSiteUrl = this.config.primaryPrivateSiteUrl?.href;
      const isPrimaryPrivateSite = primaryPrivateSiteUrl === targetUrl;
      const sticky = isPrimaryPrivateSite || (input.sticky ?? false);
      const purpose = isPrimaryPrivateSite
        ? (this.config.primaryPrivateSiteId ?? "private-site")
        : (input.purpose ?? cached?.entry.purpose ?? "generic-research");
      const reusable = sticky ? false : (input.reusable ?? true);
      const protectedTab = sticky ? true : (input.protected ?? false);
      const reuseRequest = {
        targetUrl,
        purpose,
        reusable,
        protected: protectedTab,
        sticky,
      };

      const remoteTabs = await this.reconcileBindings(true);
      const registeredTabs = this.tabsRegistry.list().filter(
        (tab) => tab.taskId === task.taskId,
      );
      const exact = selectExactTabReuse(registeredTabs, reuseRequest);
      if (exact) {
        await this.selectTab(exact.tab, remoteTabs);
        this.applyActivePageGrant(targetGrant);
        if (exact.shouldNavigate) {
          await this.beginNavigation(exact.tab.tabId, "navigate", targetUrl);
          const response = await this.driver.navigate({ url: targetUrl });
          this.updateSelectedTab(exact.tab.tabId, response, targetUrl);
          this.interactionContext.discardReferences(exact.tab.tabId);
        }
        const current = this.tabsRegistry.assertMcpOwned(exact.tab.tabId);
        const requestedUrl =
          exact.source === "current" &&
          !exact.shouldNavigate &&
          exact.tab.requestedUrl !== undefined
            ? exact.tab.requestedUrl
            : targetUrl;
        const reused = this.tabsRegistry.reconfigureMcp(exact.tab.tabId, {
          taskId: task.taskId,
          lifecycle: "task-scoped",
          purpose,
          reusable,
          protected: protectedTab,
          sticky,
          url: current.url ?? targetUrl,
          requestedUrl,
          ...(current.title === undefined ? {} : { title: current.title }),
          ...(sticky ? { lockedUrl: targetUrl } : {}),
        });
        this.taskRegistry.attachTab(task.taskId, exact.tab.tabId, context);
        this.tabBindings.syncUnifiedTab(exact.tab.tabId);
        await this.checkpoint();
        await this.recordNavigation(reused);
        this.observeTabSelection(task.taskId, reused, "exact", cacheState, exact.shouldNavigate);
        return this.withTabState(
          cacheResult(reused, cached),
          input.knownRevision,
          elapsedMs(actionStarted),
        context,
        );
      }

      const recyclable = selectRecyclableTab(registeredTabs, reuseRequest);
      if (recyclable) {
        await this.selectTab(recyclable.tab, remoteTabs);
        this.applyActivePageGrant(targetGrant);
        if (recyclable.shouldNavigate) {
          await this.beginNavigation(recyclable.tab.tabId, "navigate", targetUrl);
          const response = await this.driver.navigate({ url: targetUrl });
          this.updateSelectedTab(recyclable.tab.tabId, response, targetUrl);
        }
        const current = this.tabsRegistry.assertMcpOwned(recyclable.tab.tabId);
        const repurposed = this.tabsRegistry.reconfigureMcp(recyclable.tab.tabId, {
          taskId: task.taskId,
          lifecycle: "task-scoped",
          purpose,
          reusable,
          protected: protectedTab,
          sticky,
          url: current.url ?? targetUrl,
          requestedUrl: targetUrl,
          ...(current.title === undefined ? {} : { title: current.title }),
          ...(sticky ? { lockedUrl: targetUrl } : {}),
        });
        this.taskRegistry.attachTab(task.taskId, recyclable.tab.tabId, context);
        this.interactionContext.discardReferences(recyclable.tab.tabId);
        this.tabBindings.syncUnifiedTab(recyclable.tab.tabId);
        await this.checkpoint();
        await this.recordNavigation(repurposed);
        this.observeTabSelection(task.taskId, repurposed, "recycled", cacheState, recyclable.shouldNavigate);
        return this.withTabState(
          cacheResult(repurposed, cached),
          input.knownRevision,
          elapsedMs(actionStarted),
          context,
        );
      }

      const maxOwnedTabs = this.config.maxOwnedTabs ?? 8;
      if (registeredTabs.length >= maxOwnedTabs) {
        throw new AppError(
          "LIMIT_EXCEEDED",
          `Browser Worker reached the limit of ${maxOwnedTabs} MCP-owned tabs. Reuse or close an existing tab before opening another.`,
        );
      }

      const createdRemoteTabs = targetGrant
        ? await this.newAuthorizedTab(targetUrl, targetGrant)
        : await this.driver.newTab(targetUrl);
      const current = requireCurrentTab(createdRemoteTabs);
      const tab = this.tabsRegistry.registerMcp({
        taskId: task.taskId,
        lifecycle: "task-scoped",
        purpose,
        reusable,
        protected: protectedTab,
        sticky,
        url: current.url,
        requestedUrl: targetUrl,
        title: current.title,
        ...(sticky ? { lockedUrl: targetUrl } : {}),
      });
      this.taskRegistry.attachTab(task.taskId, tab.tabId, context);
      this.tabBindings.bind(tab.tabId, current, createdRemoteTabs.length);
      await this.checkpoint();
      await this.recordNavigation(tab);
      this.observeTabSelection(task.taskId, tab, "created", cacheState, targetUrl !== "about:blank");
      return this.withTabState(
        cacheResult(tab, cached),
        input.knownRevision,
        elapsedMs(actionStarted),
          context,
      );
    });
  }

  async navigate(
    input: BrowserNavigateInput,
    context: OperationContext = {},
  ): Promise<BrowserTabResult> {
    const tab = this.tabsRegistry.assertNavigable(input.tabId, input.url);
    const task = this.taskRegistry.assertTabAccess(tab.tabId, context);
    const targetGrant = this.requireTargetGrant(task, normalizeUrl(input.url));
    await this.selectTab(tab, undefined, false);
    this.applyActivePageGrant(targetGrant);
    await this.beginNavigation(tab.tabId, "navigate", input.url);
    const actionStarted = performance.now();
    const response = await this.driver.navigate({
      url: input.url,
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    });
    const actionMs = elapsedMs(actionStarted);
    this.updateSelectedTab(tab.tabId, response, input.url);
    const updated = this.updateRequestedUrl(tab.tabId, input.url);
    await this.checkpoint();
    await this.recordNavigation(updated);
    return this.withTabState(
      { tab: updated },
      input.knownRevision,
      actionMs,
      context,
    );
  }

  async snapshot(
    input: BrowserSnapshotInput,
    context: OperationContext = {},
  ): Promise<BrowserSnapshotResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    if (isDirectPlaywrightDriver(this.driver)) {
      return this.captureDirectSnapshotSelected(
        tab.tabId,
        input.knownRevision,
        input.forceFull,
        0,
        context,
      );
    }
    return this.captureSnapshotSelected(tab.tabId);
  }

  async click(
    input: BrowserClickInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    this.assertBusinessReadOnlyReference(tab, input.ref, "click");
    await this.selectTab(tab);
    const reference = this.interactionContext.requireReference(
      tab.tabId,
      input.ref,
    );
    const authorization = this.interactionContext.prepareDangerousAction(
      tab,
      reference,
      "click",
    );
    if (authorization) {
      this.authorizeAction(input.confirmationId, authorization);
    }
    await this.beginNavigation(tab.tabId, "click");
    const actionStarted = performance.now();
    const response = await this.driver.click({
      target: reference.ref,
      element: reference.name || reference.role,
    });
    const actionMs = elapsedMs(actionStarted);
    this.updateSelectedTab(tab.tabId, response);
    this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    return this.withActionState(tab.tabId, input.knownRevision, actionMs, context);
  }

  async fill(
    input: BrowserFillInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const reference = this.interactionContext.requireReference(
      tab.tabId,
      input.ref,
    );
    const actionStarted = performance.now();
    const response = await this.driver.fill({
      target: reference.ref,
      element: reference.name || reference.role,
      text: input.value,
      slowly: false,
      submit: false,
    });
    const actionMs = elapsedMs(actionStarted);
    this.updateSelectedTab(tab.tabId, response);
    return this.withActionState(tab.tabId, input.knownRevision, actionMs, context);
  }

  async press(
    input: BrowserPressInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    this.assertBusinessReadOnlyKey(tab, input.key, "press");
    await this.selectTab(tab);
    if (input.key.toLowerCase() === "enter") {
      this.authorizeAction(
        input.confirmationId,
        this.interactionContext.prepareConfirmation(
          tab,
          "submit-form",
          "press",
          "keyboard:Enter",
        ),
      );
      await this.beginNavigation(tab.tabId, "press");
    }
    const actionStarted = performance.now();
    const response = await this.driver.press({ key: input.key });
    const actionMs = elapsedMs(actionStarted);
    this.updateSelectedTab(tab.tabId, response);
    this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    return this.withActionState(tab.tabId, input.knownRevision, actionMs, context);
  }

  async wait(
    input: BrowserWaitInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const actionStarted = performance.now();
    await this.waitSelected(tab.tabId, input);
    return this.withActionState(
      tab.tabId,
      input.knownRevision,
      elapsedMs(actionStarted),
      context,
    );
  }

  async extract(
    input: BrowserExtractInput,
    context: OperationContext = {},
  ): Promise<BrowserExtractResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const format = input.format ?? "text";
    const extracted = await this.extractSelected(tab.tabId, input, context);
    return {
      tabId: tab.tabId,
      format,
      value: extracted.value,
      completeness: extracted.completeness,
    };
  }



  async sequence(
    input: BrowserSequenceInput,
    context: OperationContext = {},
  ): Promise<BrowserSequenceResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    this.assertBusinessReadOnlySequence(tab, input);
    await this.selectTab(tab);
    const sequenceStarted = performance.now();
    const results: BrowserSequenceResult["steps"] = [];
    try {
      for (const [index, step] of input.steps.entries()) {
        switch (step.action) {
          case "navigate": {
            const current = this.tabsRegistry.assertNavigable(tab.tabId, step.url);
            if (
              !current.sticky &&
              this.config.primaryPrivateSiteUrl &&
              normalizeUrl(step.url) === this.config.primaryPrivateSiteUrl.href
            ) {
              throw new AppError(
                "NAVIGATION_BLOCKED",
                "Open the configured primary private site with browser_open so it can be registered as a protected sticky tab.",
              );
            }
            await this.beginNavigation(tab.tabId, "navigate", step.url, false);
            const response = await this.driver.navigate({ url: step.url });
            this.updateSelectedTab(tab.tabId, response, step.url);
            this.updateRequestedUrl(tab.tabId, step.url);
            break;
          }
          case "click": {
            const reference = this.interactionContext.requireReference(
              tab.tabId,
              step.ref,
            );
            const authorization = this.interactionContext.prepareDangerousAction(
              tab,
              reference,
              "click",
            );
            if (authorization) {
              this.authorizeAction(step.confirmationId, authorization);
            }
            await this.beginNavigation(tab.tabId, "click", undefined, false);
            const response = await this.driver.click({
              target: reference.ref,
              element: reference.name || reference.role,
            });
            this.updateSelectedTab(tab.tabId, response);
            this.updateRequestedUrl(tab.tabId);
            break;
          }
          case "fill": {
            const reference = this.interactionContext.requireReference(
              tab.tabId,
              step.ref,
            );
            const response = await this.driver.fill({
              target: reference.ref,
              element: reference.name || reference.role,
              text: step.value,
              slowly: false,
              submit: false,
            });
            this.updateSelectedTab(tab.tabId, response);
            break;
          }
          case "press": {
            if (step.key.toLowerCase() === "enter") {
              this.authorizeAction(
                step.confirmationId,
                this.interactionContext.prepareConfirmation(
                  tab,
                  "submit-form",
                  "press",
                  "keyboard:Enter",
                ),
              );
              await this.beginNavigation(tab.tabId, "press", undefined, false);
            }
            const response = await this.driver.press({ key: step.key });
            this.updateSelectedTab(tab.tabId, response);
            this.updateRequestedUrl(tab.tabId);
            break;
          }
          case "wait": {
            await this.waitSelected(tab.tabId, step);
            break;
          }
          case "extract": {
            const extracted = await this.extractSelected(tab.tabId, step, context);
            results.push({
              index,
              action: step.action,
              completed: true,
              value: extracted.value,
              completeness: extracted.completeness,
            });
            continue;
          }
        }
        results.push({ index, action: step.action, completed: true });
      }
      const snapshot = input.finalSnapshot
        ? isDirectPlaywrightDriver(this.driver)
          ? await this.captureDirectSnapshotSelected(
              tab.tabId,
              input.knownRevision,
              false,
              elapsedMs(sequenceStarted),
              context,
            )
          : await this.captureSnapshotSelected(tab.tabId)
        : undefined;
      await this.checkpoint();
      await this.recordNavigation(this.tabsRegistry.assertMcpOwned(tab.tabId));
      return {
        tabId: tab.tabId,
        completed: true,
        steps: results,
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(snapshot?.state === undefined ? {} : { state: snapshot.state }),
        ...(snapshot?.timing === undefined ? {} : { timing: snapshot.timing }),
      };
    } catch (error) {
      await this.checkpoint().catch(() => undefined);
      throw error;
    }
  }

  async frameExtract(
    input: BrowserFrameExtractInput,
    context: OperationContext = {},
  ): Promise<BrowserFrameExtractResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const extracted = await this.extractFrameSelected(input, context);
    return {
      tabId: tab.tabId,
      frame: input.frame,
      format: input.format ?? "text",
      value: extracted.value,
      completeness: extracted.completeness,
    };
  }

  async frameClick(
    input: BrowserFrameClickInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const actionStarted = performance.now();
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    const targetName = input.text ?? input.selector ?? input.frame;
    this.assertBusinessReadOnlyTarget(
      tab,
      targetName,
      "frame-click",
      "frame-element",
    );
    await this.selectTab(tab);
    const authorization = this.interactionContext.prepareDangerousTarget(
      tab,
      targetName,
      "frame-click",
      "frame-element",
    );
    if (authorization) {
      this.authorizeAction(input.confirmationId, authorization);
    }
    const releaseSemanticPermit = this.acquireSemanticRequestPermit(tab, [{
      operation: "frame-click",
      framePath: [input.frame],
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      ...(input.text === undefined ? {} : { text: input.text }),
    }]);
    let response;
    try {
      await this.beginNavigation(tab.tabId, "click");
      response = await this.frameOperations.click(input);
    } finally {
      releaseSemanticPermit();
    }
    this.updateSelectedTab(tab.tabId, response);
    this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    return this.withActionState(
      tab.tabId,
      input.knownRevision,
      actionStarted,
      context,
    );
  }

  async frameFill(
    input: BrowserFrameFillInput,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    const actionStarted = performance.now();
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const response = await this.frameOperations.fill(input);
    this.updateSelectedTab(tab.tabId, response);
    await this.checkpoint();
    return this.withActionState(
      tab.tabId,
      input.knownRevision,
      actionStarted,
      context,
    );
  }

  async profilePage(
    input: BrowserProfilePageInput,
    context?: OperationContext,
  ): Promise<BrowserProfilePageResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const execution = await this.legacyAutomation.profilePage(input, context?.signal);
    this.updateSelectedTab(tab.tabId, execution.response);
    return { tabId: tab.tabId, ...execution.result };
  }

  async domIndex(
    input: BrowserDomIndexInput,
    context?: OperationContext,
  ): Promise<BrowserDomIndexResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const execution = await this.legacyAutomation.domIndex(input, context?.signal);
    this.updateSelectedTab(tab.tabId, execution.response);
    return { tabId: tab.tabId, ...execution.result };
  }

  async frameSequence(
    input: BrowserFrameSequenceInput,
    context?: OperationContext,
  ): Promise<BrowserFrameSequenceResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    this.assertBusinessReadOnlyFrameSequence(tab, input);
    await this.selectTab(tab);
    const authorizedSteps = new Set<number>();
    for (const [index, step] of input.steps.entries()) {
      if (step.action !== "click" && !(step.action === "press" && step.key.toLowerCase() === "enter")) {
        continue;
      }
      const target = step.action === "press"
        ? `keyboard:${step.key}`
        : describeLegacyLocator(step.locator);
      const authorization = this.interactionContext.prepareDangerousTarget(
        tab,
        target,
        `legacy-${step.action}`,
        "legacy-element",
      );
      if (!authorization) continue;
      this.authorizeAction(step.confirmationId, authorization);
      authorizedSteps.add(index);
    }
    if (input.steps.some((step) => step.action === "click" || step.action === "press")) {
      await this.beginNavigation(tab.tabId, "click", undefined, false);
    }
    const semanticDescriptors: AuthorizedSiteSemanticActionDescriptor[] = input.steps
      .filter((step) => step.action === "click")
      .map((step) => ({
        operation: "frame-sequence-click" as const,
        framePath: step.framePath ?? [],
        ...(step.locator.selector === undefined ? {} : { selector: step.locator.selector }),
        ...(step.locator.text === undefined ? {} : { text: step.locator.text }),
      }));
    const releaseSemanticPermit = this.acquireSemanticRequestPermit(
      tab,
      semanticDescriptors,
    );
    let execution;
    try {
      while (true) {
        try {
          execution = await this.legacyAutomation.frameSequence(input, authorizedSteps, context?.signal);
          break;
        } catch (error) {
        const block = parseLegacyPolicyBlock(error);
        if (block?.kind !== "step" || block.index === undefined || authorizedSteps.has(block.index)) {
          throw error;
        }
        const step = input.steps[block.index];
        if (!step || (step.action !== "click" && step.action !== "press")) throw error;
        if (this.isBusinessReadOnlyTab(tab)) {
          throw new AppError(
            "ACTION_BLOCKED_BY_POLICY",
            "Business read-only policy blocked a mutating legacy action.",
          );
        }
        const category = block.risk === "destructive"
          ? "delete-or-cancel"
          : "submit-form";
        this.authorizeAction(
          step.confirmationId,
          this.interactionContext.prepareConfirmation(
            tab,
            category,
            `legacy-${step.action}`,
            block.target,
          ),
        );
          authorizedSteps.add(block.index);
        }
      }
    } finally {
      releaseSemanticPermit();
    }
    this.updateSelectedTab(tab.tabId, execution.response);
    if (input.steps.some((step) => step.action === "click" || step.action === "press")) {
      this.updateRequestedUrl(tab.tabId);
    }
    await this.checkpoint();
    return { tabId: tab.tabId, ...execution.result };
  }

  async navigatePath(
    input: BrowserNavigatePathInput,
    context?: OperationContext,
  ): Promise<BrowserNavigatePathResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    const target = input.path.join(" > ");
    this.assertBusinessReadOnlyTarget(
      tab,
      target,
      "legacy-navigate-path",
      "legacy-menu-path",
    );
    await this.selectTab(tab);
    const authorization = this.interactionContext.prepareDangerousTarget(
      tab,
      target,
      "legacy-navigate-path",
      "legacy-menu-path",
    );
    let authorized = false;
    if (authorization) {
      this.authorizeAction(input.confirmationId, authorization);
      authorized = true;
    }
    await this.beginNavigation(tab.tabId, "click", undefined, false);
    let execution;
    while (true) {
      try {
        execution = await this.legacyAutomation.navigatePath(input, authorized, context?.signal);
        break;
      } catch (error) {
        const block = parseLegacyPolicyBlock(error);
        if (block?.kind !== "path" || authorized) throw error;
        if (this.isBusinessReadOnlyTab(tab)) {
          throw new AppError(
            "ACTION_BLOCKED_BY_POLICY",
            "Business read-only policy blocked a mutating legacy path action.",
          );
        }
        const category = block.risk === "destructive"
          ? "delete-or-cancel"
          : "submit-form";
        this.authorizeAction(
          input.confirmationId,
          this.interactionContext.prepareConfirmation(
            tab,
            category,
            "legacy-navigate-path",
            block.target,
          ),
        );
        authorized = true;
      }
    }
    this.updateSelectedTab(tab.tabId, execution.response);
    this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    await this.recordNavigation(this.tabsRegistry.assertMcpOwned(tab.tabId));
    return { tabId: tab.tabId, ...execution.result };
  }
  async screenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    const relativePath = isDirectPlaywrightDriver(this.driver)
      ? path.join(
          "direct",
          "artifacts",
          "screenshots",
          `${tab.tabId}-${Date.now()}.png`,
        )
      : path.join("screenshots", `${tab.tabId}-${Date.now()}.png`);
    const absolutePath = path.join(this.config.privateDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await this.driver.takeScreenshot({
      type: "png",
      scale: "css",
      filename: relativePath.replaceAll("\\", "/"),
      fullPage: input.fullPage ?? false,
    });
    const metadata = await stat(absolutePath);
    return { tabId: tab.tabId, path: absolutePath, sizeBytes: metadata.size };
  }

  async goBack(input: BrowserTabActionInput): Promise<BrowserTabResult> {
    const tab = this.tabsRegistry.assertNavigable(input.tabId);
    if (tab.sticky) throw new AppError("NAVIGATION_BLOCKED", "Sticky tabs cannot change history.");
    await this.selectTab(tab);
    await this.beginNavigation(tab.tabId, "go-back");
    const response = await this.driver.goBack();
    this.updateSelectedTab(tab.tabId, response);
    const updated = this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    return { tab: updated };
  }

  async goForward(input: BrowserTabActionInput): Promise<BrowserTabResult> {
    const tab = this.tabsRegistry.assertNavigable(input.tabId);
    if (tab.sticky) throw new AppError("NAVIGATION_BLOCKED", "Sticky tabs cannot change history.");
    await this.selectTab(tab);
    await this.beginNavigation(tab.tabId, "go-forward");
    const response = await this.driver.goForward();
    this.updateSelectedTab(tab.tabId, response);
    const updated = this.updateRequestedUrl(tab.tabId);
    await this.checkpoint();
    return { tab: updated };
  }

  async closeTab(input: BrowserCloseTabInput): Promise<BrowserActionResult> {
    const tab = this.tabsRegistry.assertClosable(input.tabId);
    const selected = await this.selectTab(tab, undefined, false);
    await this.driver.closeTab(selected.index);
    this.tabsRegistry.remove(tab.tabId);
    this.bindings.delete(tab.tabId);
    this.unifiedTabs.delete(tab.tabId);
    this.taskRegistry.detachTab(tab.tabId);
    this.interactionContext.discardReferences(tab.tabId);
    await this.checkpoint();
    return { tabId: tab.tabId, completed: true };
  }

  async finishTask(
    input: BrowserFinishTaskInput,
    context: OperationContext = {},
  ): Promise<BrowserFinishTaskResult> {
    return this.withLifecycleLock(async () => {
      const resolved = this.taskRegistry.resolveScoped(input.taskId, context, true);
      if (resolved.state === "finished") {
        this.telemetry?.record({
          event: "browser_task_finish_replayed",
          status: "allowed",
          taskRef: this.telemetry.reference("task", resolved.taskId),
          taskState: "finished",
          closedTabs: 0,
          browserClosed: !this.driver.isConnected(),
        });
        return {
          completed: true,
          taskId: resolved.taskId,
          closedTabs: 0,
          browserClosed: !this.driver.isConnected(),
        };
      }

      if (this.hasLongLivedTaskActivity(resolved.taskId)) {
        throw new AppError(
          "TASK_SUSPENDED",
          "The browser task has an active trace or video and cannot be finalized yet.",
        );
      }
      const task = this.taskRegistry.beginFinish(resolved.taskId, context);
      try {
        await this.waitForTaskLeases(task.taskId, context);
        const tabs = task.tabIds
          .map((tabId) => this.tabsRegistry.list().find((tab) => tab.tabId === tabId))
          .filter((tab): tab is BrowserTab => tab !== undefined);
        for (const tab of tabs) this.navigationCache.record(tab, { closed: true });
        await this.navigationCache.save().catch(() => undefined);

        for (const tab of tabs) {
          if (this.driver.isConnected()) {
            try {
              const selected = await this.selectTab(tab, undefined, false);
              await this.driver.closeTab(selected.index);
            } catch (error) {
              if (!(error instanceof AppError) || !["TAB_NOT_FOUND", "TAB_NOT_OWNED", "BROWSER_DISCONNECTED"].includes(error.code)) {
                throw error;
              }
            }
          }
          this.sessionState.discardTaskTab(tab.tabId);
        }

        this.confirmations.discardTabs(task.tabIds);
        this.revokeTaskSiteGrants(task.taskId);
        this.activeTraceTasks.delete(task.taskId);
        this.activeVideoTasks.delete(task.taskId);
        this.taskRegistry.completeFinish(task.taskId);
        await this.checkpoint();

        let browserClosed = false;
        const unfinishedTasks = this.taskRegistry.snapshot().filter((candidate) =>
          candidate.state === "active" || candidate.state === "suspended",
        );
        if (unfinishedTasks.every((candidate) => candidate.tabIds.length === 0) && this.driver.isConnected()) {
          const remoteTabs = await this.driver.listTabs().catch(() => []);
          if (remoteTabs.length === 0) {
            await this.driver.close();
            this.disconnectedReady = true;
            this.state = "disconnected";
            this.sessionState.transition("disconnected");
            await this.checkpoint();
            browserClosed = true;
          }
        }

        if (!browserClosed) this.scheduleContextIdleShutdown();
        this.telemetry?.record({
          event: "browser_task_finished",
          status: "allowed",
          taskRef: this.telemetry.reference("task", task.taskId),
          taskState: "finished",
          closedTabs: tabs.length,
          browserClosed,
        });
        return {
          completed: true,
          taskId: task.taskId,
          closedTabs: tabs.length,
          browserClosed,
        };
      } catch (error) {
        this.taskRegistry.restoreAfterFailedFinalization(task.taskId);
        await this.checkpoint().catch(() => undefined);
        throw error;
      }
    });
  }

  async download(input: BrowserDownloadInput): Promise<BrowserDownloadResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    await this.selectTab(tab);
    return this.fileTransfers.download(input, {
      tab,
      resolveReference: (ref) =>
        this.interactionContext.requireReference(tab.tabId, ref),
    });
  }

  async upload(input: BrowserUploadInput): Promise<BrowserUploadResult> {
    const tab = this.tabsRegistry.assertMcpOwned(input.tabId);
    if (this.isBusinessReadOnlyTab(tab)) {
      throw new AppError(
        "ACTION_BLOCKED_BY_POLICY",
        "Business read-only policy blocks file uploads.",
      );
    }
    await this.selectTab(tab);
    return this.fileTransfers.upload(input, {
      tab,
      resolveReference: (ref) =>
        this.interactionContext.requireReference(tab.tabId, ref),
      authorizeUpload: (target) =>
        this.authorizeAction(
          input.confirmationId,
          this.interactionContext.prepareConfirmation(
            tab,
            "upload-file",
            "upload",
            target,
          ),
        ),
    });
  }

  async console(input: BrowserConsoleInput): Promise<BrowserConsoleResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "console");
    return { tabId: tab.tabId, ...(await this.advancedDiagnostics.console(input)) };
  }

  async networkList(
    input: BrowserNetworkListInput,
  ): Promise<BrowserNetworkResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "networkList");
    return {
      tabId: tab.tabId,
      ...(await this.advancedDiagnostics.networkList(input)),
    };
  }

  async networkInspect(
    input: BrowserNetworkInspectInput,
  ): Promise<BrowserNetworkResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "networkInspect");
    return {
      tabId: tab.tabId,
      ...(await this.advancedDiagnostics.networkInspect(input)),
    };
  }

  async traceStart(input: BrowserTraceInput): Promise<BrowserTraceStartResult> {
    this.assertNoCredentialAuthentication("trace");
    const tab = await this.selectAdvancedTab(input.tabId, "traceStart");
    this.assertNoCredentialAuthentication("trace");
    const activityId = this.diagnosticActivityId(tab.tabId);
    this.activeTraceTasks.add(activityId);
    try {
      return {
        tabId: tab.tabId,
        ...(await this.advancedDiagnostics.traceStart()),
      };
    } catch (error) {
      this.activeTraceTasks.delete(activityId);
      throw error;
    }
  }

  async traceStop(input: BrowserTraceInput): Promise<BrowserTraceStopResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "traceStop", false);
    const result = { tabId: tab.tabId, ...(await this.advancedDiagnostics.traceStop()) };
    this.activeTraceTasks.delete(this.diagnosticActivityId(tab.tabId));
    return result;
  }

  async videoStart(
    input: BrowserVideoStartInput,
  ): Promise<BrowserVideoStartResult> {
    this.assertNoCredentialAuthentication("video");
    const tab = await this.selectAdvancedTab(input.tabId, "videoStart");
    this.assertNoCredentialAuthentication("video");
    const activityId = this.diagnosticActivityId(tab.tabId);
    this.activeVideoTasks.add(activityId);
    try {
      return {
        tabId: tab.tabId,
        ...(await this.advancedDiagnostics.videoStart(input)),
      };
    } catch (error) {
      this.activeVideoTasks.delete(activityId);
      throw error;
    }
  }

  async videoStop(
    input: BrowserVideoStopInput,
  ): Promise<BrowserVideoStopResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "videoStop", false);
    const result = { tabId: tab.tabId, ...(await this.advancedDiagnostics.videoStop()) };
    this.activeVideoTasks.delete(this.diagnosticActivityId(tab.tabId));
    return result;
  }

  async pdf(input: BrowserPdfInput): Promise<BrowserPdfResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "pdf");
    return { tabId: tab.tabId, ...(await this.advancedDiagnostics.pdf(input)) };
  }

  async diagnostics(
    input: BrowserDiagnosticsInput,
  ): Promise<BrowserDiagnosticsResult> {
    const tab = await this.selectAdvancedTab(input.tabId, "diagnostics");
    return {
      tabId: tab.tabId,
      ...(await this.advancedDiagnostics.diagnostics(input)),
    };
  }

  async checkpoint(): Promise<void> {
    return this.sessionState.checkpoint();
  }

  acquireOperationLease(
    operation: BrowserOperation,
    input: Record<string, unknown>,
    context: OperationContext = {},
  ): BrowserTaskLease {
    const tabId = typeof input.tabId === "string" ? input.tabId : undefined;
    if (!tabId || ["open", "tabs", "connect", "finishTask", "status"].includes(operation)) {
      return { taskId: "unscoped", release: () => undefined };
    }
    const task = this.taskRegistry.assertTabAccess(tabId, context);
    const lease = this.taskRegistry.acquireForTask(task.taskId, context);
    try {
      if (operationRequiresPrivateGrant(operation)) {
        this.requireTabSiteGrant(task, tabId);
      }
      this.connectionTaskId = lease.taskId;
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.taskReaperTimer) clearInterval(this.taskReaperTimer);
    if (this.contextIdleTimer) clearTimeout(this.contextIdleTimer);
    this.taskReaperTimer = undefined;
    this.contextIdleTimer = undefined;
    this.recoveryRequired = false;
    try {
      await this.driver.close();
    } finally {
      this.state = "disconnected";
      this.sessionState.transition("disconnected");
      await this.checkpoint();
    }
  }

  private async captureDirectSnapshotSelected(
    tabId: string,
    knownRevision?: number,
    forceFull = false,
    actionMs = 0,
    context: OperationContext = {},
  ): Promise<BrowserSnapshotResult> {
    if (!isDirectPlaywrightDriver(this.driver)) {
      return this.captureSnapshotSelected(tabId);
    }
    const snapshotStarted = performance.now();
    await this.stabilizeSelectedPage(context);
    const captured = await this.driver.captureSemanticSnapshot({
      ...(knownRevision === undefined ? {} : { knownRevision }),
      ...(forceFull ? { forceFull: true } : {}),
    });
    const snapshotMs = elapsedMs(snapshotStarted);
    const page = this.driver.currentPage();
    const url = normalizeUrl(page.url());
    const title = await page.title().catch(() => "");
    const tab = this.tabsRegistry.touch(tabId, { url, title });
    const binding = this.bindings.get(tabId);
    if (binding) {
      this.bindings.set(tabId, { ...binding, url, title });
      this.tabBindings.syncUnifiedTab(tabId);
    }
    const refs = captured.referenceMode === "replace"
      ? this.interactionContext.captureReferences(tabId, captured.fullContent)
      : captured.referenceMode === "merge"
        ? this.interactionContext.mergeReferences(tabId, captured.fullContent)
        : this.interactionContext.currentReferences(tabId);
    const state = captured.update;
    const content = knownRevision === undefined || state.kind === "full"
      ? captured.fullContent
      : state.snapshot ?? "";
    const timing: BrowserOperationTiming = {
      actionMs,
      snapshotMs,
      totalMs: actionMs + snapshotMs,
    };
    return {
      tabId,
      url: tab.url ?? "about:blank",
      ...(tab.title === undefined ? {} : { title: tab.title }),
      content,
      refs,
      state,
      timing,
    };
  }

  private async withActionState(
    tabId: string,
    knownRevision: number | undefined,
    actionMs: number,
    context: OperationContext = {},
  ): Promise<BrowserActionResult> {
    if (!isDirectPlaywrightDriver(this.driver)) {
      return { tabId, completed: true };
    }
    const snapshot = await this.captureDirectSnapshotSelected(
      tabId,
      knownRevision,
      false,
      actionMs,
      context,
    );
    return {
      tabId,
      completed: true,
      state: snapshot.state!,
      timing: snapshot.timing!,
    };
  }

  private async withTabState(
    result: BrowserTabResult,
    knownRevision: number | undefined,
    actionMs: number,
    context: OperationContext = {},
  ): Promise<BrowserTabResult> {
    if (!isDirectPlaywrightDriver(this.driver)) return result;
    const snapshot = await this.captureDirectSnapshotSelected(
      result.tab.tabId,
      knownRevision,
      false,
      actionMs,
      context,
    );
    return {
      ...result,
      tab: this.tabsRegistry.assertMcpOwned(result.tab.tabId),
      state: snapshot.state,
      timing: snapshot.timing,
    };
  }

  private async captureSnapshotSelected(tabId: string): Promise<BrowserSnapshotResult> {
    const snapshot = await this.pageRead.captureSnapshot(tabId);
    return {
      tabId,
      url: snapshot.tab.url ?? "about:blank",
      ...(snapshot.tab.title === undefined ? {} : { title: snapshot.tab.title }),
      content: snapshot.content,
      refs: snapshot.refs,
    };
  }

  private async waitSelected(
    tabId: string,
    input: Pick<BrowserWaitInput, "timeoutMs" | "text" | "ref">,
  ): Promise<void> {
    return this.pageRead.wait(tabId, input);
  }

  private async extractSelected(
    tabId: string,
    input: Pick<BrowserExtractInput, "ref" | "selector" | "format" | "completion">,
    context: OperationContext = {},
  ): Promise<BrowserCompletedExtraction> {
    const format = input.format ?? "text";
    const targeted = input.ref !== undefined || input.selector !== undefined;
    if (targeted || !isDirectPlaywrightDriver(this.driver)) {
      await this.stabilizeSelectedPage(context);
      const value = await this.pageRead.extract(input);
      return {
        value,
        completeness: {
          status: targeted ? "complete" : "partial",
          reason: targeted ? "targeted" : "visible-only",
          mode: "visible",
          pages: 1,
          scrolls: 0,
          bytes: extractionValueBytes(value),
        },
      };
    }

    const directDriver = this.driver;
    const service = new BrowserExtractionCompletenessService({
      probe: (currentFormat) => directDriver.probeExtraction(currentFormat),
      advanceScroll: () => directDriver.advanceExtractionScroll(),
      stabilize: () => this.stabilizeSelectedPage(context),
      read: (currentFormat) => this.pageRead.extract({ format: currentFormat }),
      navigateNext: (url) => this.navigateExtractionNext(tabId, url, context),
    });
    const result = await service.extract({
      format,
      mode: input.completion ?? "document",
      maxScrolls: this.config.extractionMaxScrolls ?? 24,
      maxPages: this.config.extractionMaxPages ?? 5,
      maxBytes: this.config.extractionMaxBytes ?? 8 * 1024 * 1024,
      timeoutMs: this.extractionTimeoutMs(context),
      noProgressLimit: this.config.extractionNoProgressLimit ?? 2,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    this.recordExtractionCompleteness(result.completeness, "page");
    return result;
  }

  private async extractFrameSelected(
    input: BrowserFrameExtractInput,
    context: OperationContext = {},
  ): Promise<BrowserCompletedExtraction> {
    const format = input.format ?? "text";
    if (input.selector !== undefined || !isDirectPlaywrightDriver(this.driver)) {
      await this.stabilizeSelectedPage(context, input.frame);
      const extracted = await this.frameOperations.extract(input);
      return {
        value: extracted.value,
        completeness: {
          status: input.selector === undefined ? "partial" : "complete",
          reason: input.selector === undefined ? "visible-only" : "targeted",
          mode: "visible",
          pages: 1,
          scrolls: 0,
          bytes: extractionValueBytes(extracted.value),
        },
      };
    }

    const directDriver = this.driver;
    const service = new BrowserExtractionCompletenessService({
      probe: (currentFormat) => directDriver.probeExtraction(currentFormat, input.frame),
      advanceScroll: () => directDriver.advanceExtractionScroll(input.frame),
      stabilize: () => this.stabilizeSelectedPage(context, input.frame),
      read: async (currentFormat) => (
        await this.frameOperations.extract({
          ...input,
          format: currentFormat,
        })
      ).value,
    });
    const result = await service.extract({
      format,
      mode: input.completion ?? "document",
      maxScrolls: this.config.extractionMaxScrolls ?? 24,
      maxPages: 1,
      maxBytes: this.config.extractionMaxBytes ?? 8 * 1024 * 1024,
      timeoutMs: this.extractionTimeoutMs(context),
      noProgressLimit: this.config.extractionNoProgressLimit ?? 2,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    this.recordExtractionCompleteness(result.completeness, "frame");
    return result;
  }

  private async navigateExtractionNext(
    tabId: string,
    nextUrl: string,
    context: OperationContext,
  ): Promise<boolean> {
    const current = this.tabsRegistry.assertMcpOwned(tabId);
    if (!current.url) return false;
    let currentUrl: URL;
    let targetUrl: URL;
    try {
      currentUrl = new URL(current.url);
      targetUrl = new URL(nextUrl, current.url);
    } catch {
      return false;
    }
    if (
      !["http:", "https:"].includes(targetUrl.protocol) ||
      targetUrl.origin !== currentUrl.origin ||
      targetUrl.username !== "" ||
      targetUrl.password !== ""
    ) {
      return false;
    }
    try {
      this.tabsRegistry.assertNavigable(tabId, targetUrl.href);
    } catch {
      return false;
    }
    await this.navigate(
      {
        tabId,
        url: targetUrl.href,
        waitUntil: "domcontentloaded",
      },
      context,
    );
    return true;
  }

  private extractionTimeoutMs(context: OperationContext): number {
    const configured = this.config.extractionTimeoutMs ?? 20_000;
    if (context.deadline === undefined) return configured;
    return Math.max(
      1,
      Math.min(configured, remainingOperationTimeMs(context.deadline)),
    );
  }

  private recordExtractionCompleteness(
    completeness: BrowserCompletedExtraction["completeness"],
    scope: "page" | "frame",
  ): void {
    this.telemetry?.record({
      event: "browser_extraction_completeness",
      status: completeness.status,
      reason: completeness.reason,
      extractionScope: scope,
      extractionMode: completeness.mode,
      extractionPages: completeness.pages,
      extractionScrolls: completeness.scrolls,
      extractionBytes: completeness.bytes,
      paginationAvailable: completeness.paginationAvailable ?? false,
    });
  }

  private async stabilizeSelectedPage(
    context: OperationContext = {},
    frameName?: string,
  ): Promise<void> {
    if (!isDirectPlaywrightDriver(this.driver)) return;
    const startedAt = performance.now();
    const remainingMs = context.deadline === undefined
      ? PAGE_STABILIZATION_MAX_MS
      : remainingOperationTimeMs(context.deadline);
    const timeoutMs = Math.max(
      1,
      Math.min(PAGE_STABILIZATION_MAX_MS, remainingMs),
    );
    try {
      const result = frameName === undefined
        ? await this.driver.stabilizePage({
            timeoutMs,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
        : await this.driver.stabilizeFrame(frameName, {
            timeoutMs,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
      this.telemetry?.record({
        event: "browser_page_stabilization",
        status: result.status,
        stabilizationScope: frameName === undefined ? "page" : "frame",
        durationMs: result.elapsedMs,
        stabilizationSamples: result.samples,
        pendingRelevantRequests: result.pendingRelevantRequests,
        unreadyFrames: result.unreadyFrames,
      });
    } catch (error) {
      this.telemetry?.record({
        event: "browser_page_stabilization",
        status: "error",
        stabilizationScope: frameName === undefined ? "page" : "frame",
        reason: error instanceof AppError ? error.code : "INTERNAL_ERROR",
        durationMs: elapsedMs(startedAt),
      });
      throw error;
    }
  }

  private async recordNavigation(tab: BrowserTab): Promise<void> {
    if (!this.navigationCache.record(tab)) return;
    await this.navigationCache.save().catch(() => undefined);
  }

  private async selectAdvancedTab(
    tabId: string,
    operation: BrowserAdvancedOperation,
    enforcePrivateGrant = true,
  ): Promise<BrowserTab> {
    const tab = this.tabsRegistry.assertMcpOwned(tabId);
    await this.ensureConnection();
    assertBrowserOperationAllowed(
      operation,
      this.session.mode,
      this.driver,
    );
    await this.selectTab(tab, undefined, enforcePrivateGrant);
    return tab;
  }

  private async ensureConnection(taskId?: string): Promise<void> {
    if (taskId) this.connectionTaskId = taskId;
    if (this.shutdownRequested) {
      throw new AppError("BROWSER_DISCONNECTED", "The Browser Worker runtime has been shut down.");
    }
    if (this.isReady()) return;

    if (this.connectPromise) {
      if (this.recoveryInProgress) {
        this.recoveryMetrics.recoveryContentionCount += 1;
      }
      return this.connectPromise;
    }

    const requiresRecovery =
      this.recoveryRequired || this.state === "connected";
    const operation = requiresRecovery
      ? this.recoverUsableContext()
      : this.connectInternal();
    this.connectPromise = operation.finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private driverHasUsablePage(): boolean {
    return this.driver.hasUsablePage?.() ?? this.driver.isConnected();
  }

  private async recoverUsableContext(): Promise<void> {
    const startedAt = performance.now();
    const wasConnected = this.driver.isConnected();
    const bindingsBefore = new Map(
      [...this.bindings].map(([tabId, binding]) => [
        tabId,
        binding.remoteTabId,
      ]),
    );
    this.recoveryInProgress = true;
    this.recoveryMetrics.zeroPageDetections += 1;
    this.recoveryMetrics.contextRecoveriesAttempted += 1;
    this.recoveryMetrics.staleReferencesRemoved +=
      this.interactionContext.clearReferences();
    this.confirmations.clear();

    let contextRestarted = !wasConnected;
    let recoveryStatus: "allowed" | "error" = "error";
    let pagesRecreated = 0;
    this.telemetry?.record({
      event: "browser_context_recovery_started",
      status: "started",
      contextRestarted,
    });
    try {
      try {
        await this.connectInternal();
      } catch (firstError) {
        if (!wasConnected) throw firstError;
        contextRestarted = true;
        await this.driver.close().catch(() => undefined);
        this.state = "disconnected";
        this.sessionState.transition("disconnected");
        await this.connectInternal();
      }

      if (!this.isReady()) {
        throw new AppError(
          "BROWSER_CONTEXT_RECOVERY_FAILED",
          "The browser context recovery completed without a usable page.",
        );
      }

      const recoveredTabs = await this.driver.listTabs();
      pagesRecreated = recoveredTabs.filter((tab) => !tab.crashed).length;
      this.recoveryMetrics.pagesRecreated += pagesRecreated;
      if (contextRestarted) {
        this.recoveryMetrics.contextsRestarted += 1;
      }
      this.recoveryRequired = false;
      this.recoveryMetrics.contextRecoveriesSucceeded += 1;
      recoveryStatus = "allowed";
    } catch (error) {
      this.recoveryMetrics.contextRecoveriesFailed += 1;
      throw new AppError(
        "BROWSER_CONTEXT_RECOVERY_FAILED",
        "The Browser Worker could not restore a usable browser context.",
        { cause: error },
      );
    } finally {
      let staleBindingsRemoved = 0;
      for (const [tabId, remoteTabId] of bindingsBefore) {
        const current = this.bindings.get(tabId);
        if (!current || current.remoteTabId !== remoteTabId) {
          this.recoveryMetrics.staleBindingsRemoved += 1;
          staleBindingsRemoved += 1;
        }
      }
      const durationMs = elapsedMs(startedAt);
      this.recoveryMetrics.recoveryDurationMs += durationMs;
      this.recoveryInProgress = false;
      this.telemetry?.record({
        event: "browser_context_recovery_completed",
        status: recoveryStatus,
        ...(recoveryStatus === "error" ? { reason: "BROWSER_CONTEXT_RECOVERY_FAILED" } : {}),
        durationMs,
        contextRestarted,
        pagesRecreated,
        staleBindingsRemoved,
      });
    }
  }

  private async connectInternal(): Promise<void> {
    this.state = "connecting";
    this.sessionState.transition("starting");
    await this.checkpoint();
    try {
      this.syncPrivateOriginActivation();
      await this.connectionBootstrap.connect();
      for (const tab of this.tabsRegistry.list()) {
        if (tab.taskId) this.taskRegistry.attachExistingTab(tab.taskId, tab.tabId);
      }
      this.state = "connected";
      this.disconnectedReady = true;
      this.sessionState.transition("connected");
      await this.checkpoint();
    } catch (error) {
      this.disconnectedReady = false;
      this.state = "disconnected";
      this.sessionState.transition("failed");
      await Promise.allSettled([this.driver.close()]);
      await this.checkpoint();
      throw error;
    }
  }


  private startTaskReaper(): void {
    const intervalMs = this.config.taskReaperIntervalMs ?? 30_000;
    this.taskReaperTimer = setInterval(() => {
      this.syncPrivateOriginActivation();
      void this.reapExpiredTasks().catch(() => undefined);
    }, intervalMs);
    this.taskReaperTimer.unref?.();
  }

  private async reapExpiredTasks(): Promise<void> {
    if (this.shutdownRequested) return;
    const candidates = this.taskRegistry.expiredCandidates();
    if (candidates.length === 0) return;
    await this.withLifecycleLock(async () => {
      let changed = false;
      for (const candidate of candidates) {
        if (
          this.confirmations.hasPendingTabs(candidate.tabIds) ||
          this.hasLongLivedTaskActivity(candidate.taskId)
        ) {
          continue;
        }
        const task = this.taskRegistry.beginExpiration(candidate.taskId);
        if (!task) continue;
        const tabs = task.tabIds
          .map((tabId) => this.tabsRegistry.list().find((tab) => tab.tabId === tabId))
          .filter((tab): tab is BrowserTab => tab !== undefined);
        try {
          for (const tab of tabs) {
            if (this.driver.isConnected()) {
              try {
                const selected = await this.selectTab(tab, undefined, false);
                await this.driver.closeTab(selected.index);
              } catch (error) {
                if (!(error instanceof AppError) || !["TAB_NOT_FOUND", "TAB_NOT_OWNED", "BROWSER_DISCONNECTED"].includes(error.code)) {
                  throw error;
                }
              }
            }
            this.sessionState.discardTaskTab(tab.tabId);
          }
          this.confirmations.discardTabs(task.tabIds);
          this.revokeTaskSiteGrants(task.taskId);
          this.taskRegistry.markExpired(task.taskId);
          this.telemetry?.record({
            event: "browser_task_expired",
            status: "allowed",
            taskRef: this.telemetry.reference("task", task.taskId),
            taskState: "expired",
            closedTabs: tabs.length,
          });
          changed = true;
        } catch (error) {
          this.taskRegistry.restoreAfterFailedFinalization(task.taskId);
          throw error;
        }
      }
      if (!changed) return;
      await this.checkpoint();
      this.scheduleContextIdleShutdown();
    });
  }

  private observeTabSelection(
    taskId: string,
    tab: BrowserTab,
    selection: "exact" | "recycled" | "created",
    cache: "hit" | "miss" | "not_applicable",
    navigated: boolean,
  ): void {
    if (!this.telemetry) return;
    this.telemetry.record({
      event: "browser_tab_selection",
      selection,
      cache,
      navigated,
      taskRef: this.telemetry.reference("task", taskId),
      tabRef: this.telemetry.reference("tab", tab.tabId),
      tabLifecycle: tab.lifecycle ?? "unknown",
      reusable: tab.reusable,
      protected: tab.protected,
      sticky: tab.sticky,
    });
  }

  private hasLongLivedTaskActivity(taskId: string): boolean {
    return this.activeTraceTasks.has(taskId) || this.activeVideoTasks.has(taskId);
  }

  private scheduleContextIdleShutdown(): void {
    if (this.contextIdleTimer || this.shutdownRequested) return;
    const hasActiveTask = this.taskRegistry.snapshot().some((task) =>
      (task.state === "active" || task.state === "suspended") && task.tabIds.length > 0,
    );
    if (hasActiveTask) return;
    const delayMs = this.config.contextIdleShutdownMs ?? 60_000;
    this.contextIdleTimer = setTimeout(() => {
      this.contextIdleTimer = undefined;
      void this.withLifecycleLock(async () => {
        const stillActive = this.taskRegistry.snapshot().some((task) =>
          (task.state === "active" || task.state === "suspended") && task.tabIds.length > 0,
        );
        if (stillActive || !this.driver.isConnected()) return;
        const remoteTabs = await this.driver.listTabs().catch(() => []);
        if (remoteTabs.length > 0) return;
        await this.driver.close();
        this.disconnectedReady = true;
        this.state = "disconnected";
        this.sessionState.transition("disconnected");
        await this.checkpoint();
        this.telemetry?.record({
          event: "browser_context_idle_closed",
          status: "allowed",
        });
      }).catch(() => undefined);
    }, delayMs);
    this.contextIdleTimer.unref?.();
  }

  private cancelContextIdleShutdown(): void {
    if (!this.contextIdleTimer) return;
    clearTimeout(this.contextIdleTimer);
    this.contextIdleTimer = undefined;
  }

  private resolvePersistentRestoreTarget(
    tab: BrowserTab,
    targetUrl: string,
  ): {
    url: string;
    allowedOrigins?: string[];
    expiresAt?: string;
  } {
    const classified = this.sitePolicies.classify(targetUrl);
    if (classified.kind === "public") return { url: targetUrl };
    if (classified.kind === "denied" || !classified.policy || !tab.taskId) {
      return { url: "about:blank" };
    }
    const grant = this.siteGrants.grantForTaskSite(
      tab.taskId,
      classified.policy.siteId,
    );
    return grant
      ? {
          url: targetUrl,
          allowedOrigins: grant.allowedOrigins,
          expiresAt: grant.expiresAt,
        }
      : { url: "about:blank" };
  }

  private isBusinessReadOnlyTab(tab: BrowserTab): boolean {
    const classified = this.sitePolicies.classify(
      normalizeUrl(tab.lockedUrl ?? tab.url ?? "about:blank"),
    );
    return classified.kind === "private" &&
      classified.policy?.accessMode === "business-read-only";
  }

  private assertBusinessReadOnlyReference(
    tab: BrowserTab,
    ref: string,
    action: string,
  ): void {
    if (!this.isBusinessReadOnlyTab(tab)) return;
    this.interactionContext.assertBusinessReadOnlyReference(
      tab.tabId,
      ref,
      action,
    );
  }

  private assertBusinessReadOnlyTarget(
    tab: BrowserTab,
    target: string,
    action: string,
    role?: string,
  ): void {
    if (!this.isBusinessReadOnlyTab(tab)) return;
    this.interactionContext.assertBusinessReadOnlyTarget(
      target,
      action,
      role,
    );
  }

  private assertBusinessReadOnlyKey(
    tab: BrowserTab,
    key: string,
    action: string,
  ): void {
    if (!this.isBusinessReadOnlyTab(tab)) return;
    if (!["enter", "numpadenter"].includes(key.toLocaleLowerCase("en-US"))) {
      return;
    }
    throw new AppError(
      "ACTION_BLOCKED_BY_POLICY",
      "Business read-only policy blocks " + action + " with Enter.",
    );
  }

  private assertBusinessReadOnlySequence(
    tab: BrowserTab,
    input: BrowserSequenceInput,
  ): void {
    if (!this.isBusinessReadOnlyTab(tab)) return;
    for (const step of input.steps) {
      if (step.action === "click") {
        this.interactionContext.assertBusinessReadOnlyReference(
          tab.tabId,
          step.ref,
          "sequence-click",
        );
      }
      if (step.action === "press") {
        this.assertBusinessReadOnlyKey(tab, step.key, "sequence-press");
      }
    }
  }

  private assertBusinessReadOnlyFrameSequence(
    tab: BrowserTab,
    input: BrowserFrameSequenceInput,
  ): void {
    if (!this.isBusinessReadOnlyTab(tab)) return;
    for (const step of input.steps) {
      if (step.action === "click") {
        this.interactionContext.assertBusinessReadOnlyTarget(
          describeLegacyLocator(step.locator),
          "legacy-sequence-click",
          "legacy-element",
        );
      }
      if (step.action === "press") {
        this.assertBusinessReadOnlyKey(
          tab,
          step.key,
          "legacy-sequence-press",
        );
      }
    }
  }

  private async authenticateAuthorizedSite(
    policy: ReturnType<BrowserSitePolicyRegistry["require"]>,
    taskId: string,
    tabId: string,
    context: OperationContext,
  ): Promise<BrowserSiteAuthenticationOutcome | { status: "interaction-required"; reason: "diagnostic-active" }> {
    if (policy.loginStrategy === "none") return { status: "not-required" };
    if (this.activeTraceTasks.size > 0 || this.activeVideoTasks.size > 0) {
      return { status: "interaction-required", reason: "diagnostic-active" };
    }
    this.credentialActiveTabs.add(tabId);
    this.interactionContext.discardReferences(tabId);
    try {
      return await this.siteAuthentication.authenticate(policy, context.signal);
    } finally {
      this.interactionContext.discardReferences(tabId);
      this.credentialActiveTabs.delete(tabId);
    }
  }

  private assertNoCredentialAuthentication(operation: string): void {
    if (this.credentialActiveTabs.size === 0) return;
    throw new AppError(
      "TASK_SUSPENDED",
      "Cannot start " + operation + " while credential authentication is active.",
    );
  }

  private diagnosticActivityId(tabId: string): string {
    return this.taskRegistry.taskIdForTab(tabId) ?? "tab:" + tabId;
  }

  private requireTargetGrant(
    task: BrowserTask,
    targetUrl: string,
  ): BrowserSiteGrant | undefined {
    const classified = this.sitePolicies.classify(targetUrl);
    if (classified.kind === "denied") {
      throw new AppError(
        "SITE_PRODUCTION_BLOCKED",
        "The requested site origin is permanently blocked by browser policy.",
      );
    }
    if (classified.kind === "public" || !classified.policy) return undefined;
    try {
      return this.siteGrants.requireGrant(task, classified.policy);
    } catch (error) {
      this.syncPrivateOriginActivation();
      throw error;
    }
  }

  private requireTabSiteGrant(task: BrowserTask, tabId: string): void {
    const tab = this.tabsRegistry.list().find((candidate) => candidate.tabId === tabId);
    if (!tab) return;
    this.requireTargetGrant(
      task,
      normalizeUrl(tab.lockedUrl ?? tab.url ?? "about:blank"),
    );
  }

  private applyActivePageGrant(grant: BrowserSiteGrant | undefined): void {
    this.driver.setActivePageAllowedOrigins?.(
      grant?.allowedOrigins ?? [],
      grant?.expiresAt,
    );
    const policy = grant && this.authenticatedSiteKeys.has(
      authenticatedSiteKey(grant.taskId, grant.siteId),
    )
      ? this.sitePolicies.require(grant.siteId)
      : undefined;
    this.driver.setActivePageRequestPolicy?.(policy);
  }

  private async newAuthorizedTab(
    targetUrl: string,
    grant: BrowserSiteGrant,
  ): Promise<BrowserDriverTab[]> {
    if (!this.driver.newTabWithAllowedOrigins) {
      throw new AppError(
        "BROWSER_CAPABILITY_UNSUPPORTED",
        "The active browser driver cannot enforce private-site page authorization.",
      );
    }
    const authenticated = this.authenticatedSiteKeys.has(
      authenticatedSiteKey(grant.taskId, grant.siteId),
    );
    const tabs = await this.driver.newTabWithAllowedOrigins(
      authenticated ? "about:blank" : targetUrl,
      grant.allowedOrigins,
      grant.expiresAt,
    );
    this.applyActivePageGrant(grant);
    if (!authenticated || targetUrl === "about:blank") return tabs;
    await this.driver.navigate({ url: targetUrl });
    return this.driver.listTabs();
  }

  private syncPrivateOriginActivation(): void {
    const expiryByOrigin = new Map<string, number>();
    for (const grant of this.siteGrants.activeGrants()) {
      const expiresAt = Date.parse(grant.expiresAt);
      for (const origin of grant.allowedOrigins) {
        expiryByOrigin.set(
          origin,
          Math.max(expiryByOrigin.get(origin) ?? 0, expiresAt),
        );
      }
    }
    for (const origin of this.sitePolicies.privateOriginValues()) {
      const expiresAt = expiryByOrigin.get(origin);
      if (expiresAt === undefined) {
        this.driver.disablePrivateOrigin?.(origin);
      } else {
        this.driver.enablePrivateOrigin?.(
          origin,
          new Date(expiresAt).toISOString(),
        );
      }
    }
  }

  private revokeTaskSiteGrants(taskId: string): void {
    for (const key of this.authenticatedSiteKeys) {
      if (key.startsWith(taskId + "\u0000")) this.authenticatedSiteKeys.delete(key);
    }
    this.siteGrants.revokeTask(taskId);
    this.siteAuthentication.clearTaskState();
    this.syncPrivateOriginActivation();
  }

  private acquireSemanticRequestPermit(
    tab: BrowserTab,
    descriptors: readonly AuthorizedSiteSemanticActionDescriptor[],
  ): () => void {
    if (descriptors.length === 0) return () => undefined;
    const policy = this.authenticatedPolicyForTab(tab);
    if (!policy?.requestPolicy) return () => undefined;
    if (!descriptors.every((descriptor) =>
      isAuthorizedSiteSemanticActionAllowed(policy, descriptor)
    )) {
      return () => undefined;
    }
    return this.driver.acquireActivePageSemanticRequestPermit?.() ?? (() => undefined);
  }

  private authenticatedPolicyForTab(tab: BrowserTab): AuthorizedSitePolicy | undefined {
    const target = normalizeUrl(tab.lockedUrl ?? tab.url ?? "about:blank");
    const classified = this.sitePolicies.classify(target);
    if (classified.kind !== "private" || !classified.policy) return undefined;
    const taskId = tab.taskId ?? this.taskRegistry.taskIdForTab(tab.tabId);
    if (!taskId) return undefined;
    return this.authenticatedSiteKeys.has(
      authenticatedSiteKey(taskId, classified.policy.siteId),
    )
      ? classified.policy
      : undefined;
  }

  private async withTaskLease<T>(
    taskId: string,
    context: OperationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = this.taskRegistry.acquireForTask(taskId, context);
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  private requireConnectionTaskId(): string {
    if (this.connectionTaskId) return this.connectionTaskId;
    const task = this.taskRegistry.resolveForOpen(undefined, {});
    this.connectionTaskId = task.taskId;
    return task.taskId;
  }

  private async waitForTaskLeases(
    taskId: string,
    context: OperationContext,
  ): Promise<void> {
    const deadline = context.deadline ? Date.parse(context.deadline.deadlineAt) : Date.now() + 5_000;
    while (this.taskRegistry.leaseCount(taskId) > 0) {
      if (context.signal?.aborted) {
        throw abortSignalError(context.signal, "Browser task finalization was cancelled.");
      }
      if (Date.now() >= deadline) {
        throw new AppError(
          "TASK_SUSPENDED",
          "The browser task still has active operations and cannot be finalized yet.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async reconcileBindings(
    pruneOrphans = false,
    knownRemoteTabs?: readonly BrowserDriverTab[],
  ): Promise<readonly BrowserDriverTab[]> {
    return this.tabSelection.reconcileBindings(
      pruneOrphans,
      knownRemoteTabs,
    );
  }
  private async selectTab(
    tab: BrowserTab,
    knownRemoteTabs?: readonly BrowserDriverTab[],
    enforcePrivateGrant = true,
  ): Promise<BrowserDriverTab> {
    if (this.credentialActiveTabs.has(tab.tabId)) {
      throw new AppError(
        "TASK_SUSPENDED",
        "The browser tab is temporarily locked for credential authentication.",
      );
    }
    if (enforcePrivateGrant) {
      const task = this.taskRegistry.taskForTab(tab.tabId);
      if (task) {
        const grant = this.requireTargetGrant(
          task,
          normalizeUrl(tab.lockedUrl ?? tab.url ?? "about:blank"),
        );
        this.applyActivePageGrant(grant);
      }
    }
    return this.tabSelection.selectTab(tab, knownRemoteTabs);
  }

  private async beginNavigation(
    tabId: string,
    operation: BrowserNavigationTransition["operation"],
    expectedUrl?: string,
    persist = true,
  ): Promise<void> {
    this.navigationState.begin(tabId, operation, expectedUrl);
    if (persist) await this.checkpoint();
  }

  private updateSelectedTab(
    tabId: string,
    response: BrowserDriverResponse,
    fallbackUrl?: string,
  ): BrowserTab {
    return this.navigationState.updateSelectedTab(tabId, response, fallbackUrl);
  }

  private updateRequestedUrl(
    tabId: string,
    requestedUrl?: string,
  ): BrowserTab {
    const current = this.tabsRegistry.assertMcpOwned(tabId);
    const normalized = normalizeUrl(
      requestedUrl ?? current.url ?? "about:blank",
    );
    const updated = this.tabsRegistry.reconfigureMcp(tabId, {
      requestedUrl: normalized,
    });
    this.tabBindings.syncUnifiedTab(tabId);
    return updated;
  }

  private authorizeAction(
    confirmationId: string | undefined,
    binding: BrowserConfirmationBinding,
  ): void {
    if (confirmationId) {
      this.confirmations.consume(confirmationId, binding);
      return;
    }
    const confirmation = this.confirmations.create(binding);
    throw new AppError(
      "ACTION_REQUIRES_CONFIRMATION",
      `Confirmation required: ${JSON.stringify({ ...confirmation, category: binding.category, action: binding.action, target: binding.target })}`,
    );
  }
}

function findRuntimeSession(
  sessions: readonly BrowserSession[],
  driver: BrowserDriver["kind"],
  profileType: BrowserSession["profileType"],
): BrowserSession | undefined {
  return [...sessions]
    .filter(
      (session) =>
        session.driver === driver &&
        session.profileType === profileType,
    )
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))[0];
}

function selectRuntimeSession(
  sessions: readonly BrowserSession[],
  driver: BrowserDriver["kind"],
  mode: BrowserOperationMode,
  decision: BrowserEngineSelection,
  config: BrowserWorkerConfig,
): BrowserSession {
  const routing = {
    mode,
    routingReason: decision.reason,
    routingPolicyReason: decision.policyReason,
  };
  const profileType = profileTypeFor(config, driver);
  const existing = findRuntimeSession(sessions, driver, profileType);
  return existing
    ? applyBrowserSessionRouting(
        touchBrowserSession(existing, "disconnected"),
        routing,
      )
    : {
        ...createBrowserSession(driver, new Date().toISOString(), routing),
        profileType,
      };
}

function profileTypeFor(
  _config: BrowserWorkerConfig,
  _driver: BrowserDriver["kind"],
): BrowserSession["profileType"] {
  return "persistent";
}

function requireCurrentTab(tabs: readonly BrowserDriverTab[]): BrowserDriverTab {
  const current = tabs.find((tab) => tab.current);
  if (!current) throw new AppError("TAB_NOT_FOUND", "Playwright did not report a current browser tab.");
  if (current.crashed) throw new AppError("TAB_NOT_FOUND", "The current browser tab has crashed.");
  return current;
}


function cacheResult(
  tab: BrowserTab,
  cached: NavigationCacheLookup | undefined,
): BrowserTabResult {
  return {
    tab,
    ...(cached === undefined
      ? {}
      : { restoredFromCache: true, cacheAgeMs: cached.ageMs }),
  };
}

interface LegacyPolicyBlock {
  kind: "step" | "path";
  index?: number | undefined;
  level?: number | undefined;
  risk: "submit" | "destructive";
  target: string;
}

function parseLegacyPolicyBlock(error: unknown): LegacyPolicyBlock | undefined {
  if (!(error instanceof AppError) || error.code !== "ACTION_BLOCKED_BY_POLICY") {
    return undefined;
  }
  const marker = "Legacy action requires explicit confirmation: ";
  const offset = error.message.indexOf(marker);
  if (offset < 0) return undefined;
  try {
    const parsed = JSON.parse(error.message.slice(offset + marker.length)) as Record<string, unknown>;
    if (
      (parsed.kind !== "step" && parsed.kind !== "path") ||
      (parsed.risk !== "submit" && parsed.risk !== "destructive") ||
      typeof parsed.target !== "string"
    ) {
      return undefined;
    }
    return {
      kind: parsed.kind,
      ...(typeof parsed.index === "number" ? { index: parsed.index } : {}),
      ...(typeof parsed.level === "number" ? { level: parsed.level } : {}),
      risk: parsed.risk,
      target: parsed.target.slice(0, 200),
    };
  } catch {
    return undefined;
  }
}

function describeLegacyLocator(locator: {
  ref?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  selector?: string | undefined;
  href?: string | undefined;
  target?: string | undefined;
  text?: string | undefined;
}): string {
  return locator.text ?? locator.id ?? locator.name ?? locator.href ??
    locator.target ?? locator.selector ?? locator.ref ?? "legacy-element";
}

function authenticatedSiteKey(taskId: string, siteId: string): string {
  return taskId + "\u0000" + siteId;
}


function operationRequiresPrivateGrant(operation: BrowserOperation): boolean {
  return ![
    "navigate",
    "closeTab",
    "finishTask",
    "traceStop",
    "videoStop",
  ].includes(operation);
}

function extractionValueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
function elapsedMs(startedAt: number): number {
  return Math.max(
    0,
    Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  );
}
