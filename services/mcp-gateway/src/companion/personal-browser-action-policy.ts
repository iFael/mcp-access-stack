import { createHash } from "node:crypto";
import {
  AppError,
  clickAuthorizationAction,
  containsBrowserEnterKey,
  validateBrowserKeySequence,
  BrowserConfirmationRegistry,
  BrowserInteractionContextService,
  type BrowserClickInput,
  type BrowserDialogInput,
  type BrowserDialogResult,
  type BrowserDragInput,
  type BrowserFillInput,
  type BrowserFormInputInput,
  type BrowserPressInput,
  type BrowserTypeInput,
  type BrowserEvaluateInput,
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

  authorizeDialogResponse(
    input: BrowserDialogInput,
    observed: BrowserDialogResult,
  ): void {
    if (input.action !== "respond" || input.response !== "accept" ||
        observed.dialogType === "alert") return;
    if (observed.state !== "open" || observed.message !== input.expectedMessage) {
      throw new AppError("BROWSER_CONFIRMATION_INVALID", "Dialog changed before acceptance.");
    }
    const page = this.requirePage(input.tabId);
    const digest = createHash("sha256")
      .update(JSON.stringify([observed.dialogType, observed.message, input.response, input.promptText]))
      .digest("hex");
    this.authorize(
      input.confirmationId,
      this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url },
        observed.dialogType === "prompt" ? "submit-form" : "accept-terms-or-contract",
        "dialog-accept",
        "sha256:" + digest,
      ),
    );
  }

  guardUpload(input: import("@vs-code-gpt/shared").BrowserUploadInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    const ref = input.inputRef ?? input.triggerRef;
    const reference = ref ? this.requireRef(input.tabId, ref, page) : undefined;
    const digest = createHash("sha256")
      .update(JSON.stringify([
        input.inputRef, input.triggerRef, input.selector,
        input.files.map((file) => [
          file.name, file.mimeType,
          createHash("sha256").update(file.contentBase64).digest("hex"),
        ]),
      ]))
      .digest("hex");
    this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
      { tabId: input.tabId, url: page.url },
      "upload-file", "upload",
      "sha256:" + digest,
    ));
    return {
      url: page.url,
      ...(reference ? { ref: reference.ref, role: reference.role, name: reference.name } : {}),
    };
  }

  guardEvaluate(input: BrowserEvaluateInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    if (input.ref) this.requireRef(input.tabId, input.ref, page);
    const digest = createHash("sha256").update(input.function).digest("hex");
    this.authorize(
      input.confirmationId,
      this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url },
        "execute-script", "evaluate", "sha256:" + digest,
      ),
    );
    return { url: page.url, ...(input.ref ? { ref: input.ref } : {}) };
  }

  guardClick(input: BrowserClickInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    if (!input.ref) throw new AppError("INVALID_ARGUMENT", "Click requires a resolved snapshot ref.");
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

  guardDrag(input: BrowserDragInput): { fromGuard: PersonalActionGuard; toGuard: PersonalActionGuard } {
    const page = this.requirePage(input.tabId);
    if (!("ref" in input.from) || !("ref" in input.to)) {
      throw new AppError("INVALID_ARGUMENT", "Coordinate drag endpoints must be resolved to fresh refs.");
    }
    const source = this.requireRef(input.tabId, input.from.ref, page);
    const target = this.requireRef(input.tabId, input.to.ref, page);
    const category = this.interactions.prepareDangerousAction(
      { tabId: input.tabId, url: page.url }, source, "drag",
    )?.category ?? this.interactions.prepareDangerousAction(
      { tabId: input.tabId, url: page.url }, target, "drag",
    )?.category;
    if (category) {
      const label = `${source.role}:${source.name}=>${target.role}:${target.name}|${JSON.stringify([input.from, input.to])}`;
      this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url }, category, "drag", label,
      ));
    }
    return {
      fromGuard: { url: page.url, ref: source.ref, role: source.role, name: source.name },
      toGuard: { url: page.url, ref: target.ref, role: target.role, name: target.name },
    };
  }

  guardFormInput(input: BrowserFormInputInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    const reference = this.requireRef(input.tabId, input.ref, page);
    const binding = this.interactions.prepareDangerousAction(
      { tabId: input.tabId, url: page.url }, reference, "form-input",
    );
    if (binding) this.authorize(input.confirmationId, binding);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardType(input: BrowserTypeInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    if (input.submit) {
      this.authorize(
        input.confirmationId,
        this.interactions.prepareConfirmation(
          { tabId: input.tabId, url: page.url },
          "submit-form", "type", "keyboard:Enter:sha256:" + createHash("sha256").update(input.text).digest("hex"),
        ),
      );
    }
    return { url: page.url };
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
      if (hasNavigated && ["click", "fill", "press", "hover", "scroll", "drag", "formInput", "type"].includes(step.action)) {
        throw new AppError(
          "BROWSER_CAPABILITY_UNSUPPORTED",
          "Personal browser sequences require a fresh snapshot after navigation before interacting.",
        );
      }
      if (step.action === "click") guarded.push({ ...step, guard: this.guardClick({ ...step, tabId: input.tabId }) });
      else if (step.action === "fill") guarded.push({ ...step, guard: this.guardFill({ ...step, tabId: input.tabId }) });
      else if (step.action === "press") guarded.push({ ...step, guard: this.guardPress({ ...step, tabId: input.tabId }) });
      else if (step.action === "hover") {
        if (!step.ref) throw new AppError("INVALID_ARGUMENT", "Resolve hover coordinates against a fresh snapshot before sequencing.");
        guarded.push({ ...step, guard: this.guardReference(input.tabId, step.ref) });
      }
      else if (step.action === "scroll") guarded.push({ ...step, guard: step.ref
        ? this.guardReference(input.tabId, step.ref) : this.guardPage(input.tabId) });
      else if (step.action === "drag") guarded.push({ ...step,
        ...this.guardDrag({ ...step, tabId: input.tabId }) });
      else if (step.action === "formInput") guarded.push({ ...step,
        guard: this.guardFormInput({ ...step, tabId: input.tabId }) });
      else if (step.action === "type") guarded.push({ ...step, guard: this.guardType({ ...step, tabId: input.tabId }) });
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
