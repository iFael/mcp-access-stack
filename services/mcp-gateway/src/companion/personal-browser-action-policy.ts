import {
  AppError,
  clickAuthorizationAction,
  containsBrowserEnterKey,
  validateBrowserKeySequence,
  BrowserConfirmationRegistry,
  BrowserInteractionContextService,
  type BrowserClickInput,
  type BrowserFillInput,
  type BrowserPressInput,
  type BrowserSnapshotResult,
  type BrowserSequenceInput,
  type BrowserTab,
} from "@vs-code-gpt/shared";

export interface PersonalActionGuard {
  url: string;
  ref?: string;
  role?: string;
  name?: string;
}

export class PersonalBrowserActionPolicy {
  private readonly confirmations = new BrowserConfirmationRegistry();
  private readonly interactions = new BrowserInteractionContextService();
  private readonly pages = new Map<string, { url: string; refs: Set<string>; taskId?: string }>();

  observeTab(tab: Pick<BrowserTab, "tabId" | "url" | "taskId">): void {
    if (!tab.url) return;
    const prior = this.pages.get(tab.tabId);
    if (prior?.url !== tab.url) this.interactions.discardReferences(tab.tabId);
    this.pages.set(tab.tabId, {
      url: tab.url,
      refs: prior?.url === tab.url ? prior.refs : new Set(),
      ...((tab.taskId ?? prior?.taskId) ? { taskId: (tab.taskId ?? prior?.taskId)! } : {}),
    });
  }

  observeSnapshot(result: BrowserSnapshotResult): void {
    const prior = this.pages.get(result.tabId);
    // Structured refs are authoritative; page prose can contain forged tokens.
    this.interactions.captureStructuredReferences(result.tabId, result.refs);
    this.pages.set(result.tabId, {
      url: result.url,
      refs: new Set(result.refs.map((ref) => ref.ref)),
      ...(prior?.taskId ? { taskId: prior.taskId } : {}),
    });
    this.confirmations.discardTabs([result.tabId]);
  }

  guardClick(input: BrowserClickInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    const reference = this.requireRef(input.tabId, input.ref, page);
    const authorization = this.interactions.prepareDangerousAction(
      { tabId: input.tabId, url: page.url },
      reference,
      clickAuthorizationAction(input),
    );
    if (authorization) this.authorize(input.confirmationId, authorization);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardPage(tabId: string): PersonalActionGuard {
    const page = this.requirePage(tabId);
    return { url: page.url };
  }

  guardReference(tabId: string, ref: string): PersonalActionGuard {
    const page = this.requirePage(tabId);
    const reference = this.requireRef(tabId, ref, page);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardFill(input: BrowserFillInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    const reference = this.requireRef(input.tabId, input.ref, page);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardPress(input: BrowserPressInput): PersonalActionGuard {
    validateBrowserKeySequence(input.key, input.repeat);
    const page = this.requirePage(input.tabId);
    if (containsBrowserEnterKey(input.key)) {
      this.authorize(
        input.confirmationId,
        this.interactions.prepareConfirmation(
          { tabId: input.tabId, url: page.url },
          "submit-form", "press", "keyboard:Enter",
        ),
      );
    }
    return { url: page.url };
  }

  guardSequence(input: BrowserSequenceInput): Array<Record<string, unknown>> {
    const guarded: Array<Record<string, unknown>> = [];
    let hasNavigated = false;
    for (const step of input.steps) {
      if (step.action === "navigate") {
        hasNavigated = true;
        guarded.push(step);
        continue;
      }
      if (hasNavigated && (step.action === "click" || step.action === "fill" || step.action === "press")) {
        throw new AppError(
          "BROWSER_CAPABILITY_UNSUPPORTED",
          "Personal browser sequences require a fresh snapshot after navigation before interacting.",
        );
      }
      if (step.action === "click") guarded.push({ ...step, guard: this.guardClick({ ...step, tabId: input.tabId }) });
      else if (step.action === "fill") guarded.push({ ...step, guard: this.guardFill({ ...step, tabId: input.tabId }) });
      else if (step.action === "press") guarded.push({ ...step, guard: this.guardPress({ ...step, tabId: input.tabId }) });
      else guarded.push(step);
    }
    return guarded;
  }

  discard(tabIds: readonly string[]): void {
    this.confirmations.discardTabs(tabIds);
    for (const id of tabIds) {
      this.pages.delete(id);
      this.interactions.discardReferences(id);
    }
  }

  finish(taskId?: string): void {
    const ids = [...this.pages].filter(([, entry]) => !taskId || entry.taskId === taskId).map(([id]) => id);
    this.discard(ids);
  }

  clear(): void {
    this.confirmations.clear();
    this.interactions.clearReferences();
    this.pages.clear();
  }

  private requirePage(tabId: string): { url: string; refs: Set<string> } {
    const page = this.pages.get(tabId);
    if (!page || !/^https?:\/\//u.test(page.url)) {
      throw new AppError("INVALID_ARGUMENT", "Capture a fresh browser_snapshot for this personal Chrome tab before interacting.");
    }
    return page;
  }

  private requireRef(tabId: string, ref: string, page: { refs: Set<string> }) {
    if (!page.refs.has(ref)) {
      throw new AppError("INVALID_ARGUMENT", "The element reference is missing or stale. Capture a fresh browser_snapshot.");
    }
    return this.interactions.requireReference(tabId, ref);
  }

  private authorize(confirmationId: string | undefined, binding: Parameters<BrowserConfirmationRegistry["create"]>[0]): void {
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
