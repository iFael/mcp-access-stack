import { createHash } from "node:crypto";
import {
  AppError,
  clickAuthorizationAction,
  containsBrowserEnterKey,
  validateBrowserKeySequence,
  BrowserConfirmationRegistry,
  BrowserInteractionContextService,
  type BrowserClickInput,
  type BrowserActionResult,
  type BrowserHoverInput,
  type BrowserDialogInput,
  type BrowserDialogResult,
  type BrowserDragInput,
  type BrowserFillInput,
  type BrowserFormInputInput,
  type BrowserPressInput,
  type BrowserTypeInput,
  type BrowserEvaluateInput,
  type BrowserFrameSequenceInput,
  type BrowserNavigatePathInput,
  type BrowserSnapshotResult,
  type BrowserSequenceInput,
  type BrowserTab,
  type BrowserConfirmationBinding,
  type BrowserConfirmationCategory,
} from "@vs-code-gpt/shared";

export interface PersonalActionGuard {
  url: string;
  pixel?: true;
  x?: number;
  y?: number;
  ref?: string;
  role?: string;
  name?: string;
}

/**
 * Approvals the user gave in Chrome: a category on one origin until its task
 * ends (or, for a tab without a task, while that tab stays with MCP), or every
 * approvable category on a host the user listed for automatic approval. Only
 * the extension reports them.
 */
export type PersonalSiteGrant = { origin: string; category: string } & ({ taskId: string } | { tabId: string });

export interface PersonalSiteApprovals {
  grants: readonly PersonalSiteGrant[];
  autoSites: readonly string[];
  permanentScriptOrigins?: readonly string[];
}

export interface PersonalSiteApprovalRequest {
  tabId: string;
  origin: string;
  category: BrowserConfirmationCategory;
}

// Deleting, paying, sending, publishing, credentials and contracts always need
// a one-use confirmation. So do pixel-only input, dialog acceptance and Enter,
// which may delete, pay or send without a label anyone can classify.
export const PERSONAL_SITE_APPROVABLE_CATEGORIES: ReadonlySet<BrowserConfirmationCategory> =
  new Set(["submit-form", "upload-file", "execute-script"]);
const ONE_USE_ACTIONS: ReadonlySet<string> = new Set(["pixel-click", "pixel-drag", "dialog-accept"]);

/** Element descriptor returned by the extension preflight; never a field value. */
export interface PersonalLegacyFrameTarget {
  index: number;
  label: string;
  role: string;
  submitLike: boolean;
  deferred?: boolean;
  formMethod?: string;
}

export class PersonalBrowserActionPolicy {
  private readonly confirmations = new BrowserConfirmationRegistry();
  private readonly interactions = new BrowserInteractionContextService();
  private readonly pages = new Map<string, { url: string; title?: string; refs: Set<string>; taskId?: string }>();
  private siteApprovals: PersonalSiteApprovals | undefined;

  constructor(private readonly requestSiteApproval?: (request: PersonalSiteApprovalRequest) => void) {}

  setSiteApprovals(approvals: PersonalSiteApprovals | undefined): void {
    this.siteApprovals = approvals;
  }

  observeTab(tab: Pick<BrowserTab, "tabId" | "url" | "taskId" | "title">): void {
    if (!tab.url) return;
    const prior = this.pages.get(tab.tabId);
    if (prior?.url !== tab.url) this.interactions.discardReferences(tab.tabId);
    const title = tab.title ?? (prior?.url === tab.url ? prior.title : undefined);
    this.pages.set(tab.tabId, {
      url: tab.url,
      ...(title ? { title } : {}),
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
      ...(result.title ? { title: result.title } : {}),
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
    const ref = input.inputRef ?? input.triggerRef ?? input.dropRef;
    const reference = ref ? this.requireRef(input.tabId, ref, page) : undefined;
    const digest = createHash("sha256")
      .update(JSON.stringify([
        input.inputRef, input.triggerRef, input.selector, input.dropRef,
        input.files.map((file) => [
          file.name, file.mimeType,
          file.contentBase64 === undefined
            ? "screenshot:" + file.screenshotPath
            : createHash("sha256").update(file.contentBase64).digest("hex"),
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
      this.pageTab(input.tabId, page),
      reference,
      clickAuthorizationAction(input),
    );
    if (authorization) this.authorize(input.confirmationId, authorization);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardPixelClick(
    input: BrowserClickInput,
    screenshotUrl: string,
    inspected?: BrowserActionResult["inspected"],
  ): PersonalActionGuard & { inspected?: typeof inspected } {
    if (input.ref || input.x === undefined || input.y === undefined ||
        !Number.isInteger(input.x) || !Number.isInteger(input.y)) {
      throw new AppError("INVALID_ARGUMENT", "A physical pixel click requires exact viewport coordinates and no ref.");
    }
    const page = this.requirePage(input.tabId);
    if (page.url !== screenshotUrl) {
      throw new AppError("BROWSER_CONFIRMATION_INVALID", "The screenshot belongs to a different page.");
    }
    const target = createHash("sha256").update(JSON.stringify([
      page.url, input.x, input.y, input.button ?? "left",
      input.clickCount ?? 1, [...(input.modifiers ?? [])].sort(), inspected ?? null,
    ])).digest("hex");
    const ordinaryClick = (input.button ?? "left") === "left" &&
      (input.clickCount ?? 1) === 1 && (input.modifiers ?? []).length === 0;
    const role = inspected?.role.replace(/:(?:submit|image)$/u, "");
    const frameContext = inspected ? { tabId: input.tabId, url: inspected.frameUrl,
      title: inspected.frameTitle } : undefined;
    const identifiedRisk = inspected && ordinaryClick
      ? this.interactions.prepareDangerousTarget(
          frameContext ?? this.pageTab(input.tabId, page), inspected.name, "pixel-click", role,
        )?.category
      : undefined;
    // A GET form can be navigational, but a POST submit is not proven read-only
    // merely because its caption says "Pesquisar" or "Consultar".
    const queryLabel = Boolean(inspected && /^(pesquisar|filtrar|consultar|exibir)$/iu.test(inspected.name));
    const safeQuery = inspected?.formMethod === "get" && queryLabel;
    const category = identifiedRisk ?? (frameContext && this.interactions.pageRiskCategory(frameContext)) ??
      this.interactions.pageRiskCategory(page) ??
      (inspected && ordinaryClick && inspected.submitLike && !safeQuery
        ? "submit-form" : undefined);
    if (category) {
      // A verified legacy POST query may use an existing task-scoped site
      // submit grant, just like a semantic form control. Never infer read-only
      // semantics solely from the caption, or extend that grant to blind clicks.
      const action = ordinaryClick && inspected?.submitLike && queryLabel &&
        inspected.formMethod === "post" && category === "submit-form" &&
        !this.interactions.pageRiskCategory(page) &&
        !(frameContext && this.interactions.pageRiskCategory(frameContext))
        ? "pixel-semantic-query" : "pixel-click";
      this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url }, category,
        action, "sha256:" + target,
      ));
    } else if (!inspected || !ordinaryClick) {
      // Unclassified pixels retain the existing bounded one-use safeguard.
      this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url },
        this.interactions.pageRiskCategory(page) ?? "submit-form",
        "pixel-click", "sha256:" + target,
      ));
    }
    return { url: page.url, pixel: true, x: input.x, y: input.y,
      ...(inspected && ordinaryClick ? { inspected } : {}) };
  }

  guardPixelHover(input: BrowserHoverInput, screenshotUrl: string): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    if (input.ref || input.x === undefined || input.y === undefined ||
        !Number.isInteger(input.x) || !Number.isInteger(input.y) || page.url !== screenshotUrl) {
      throw new AppError("BROWSER_CONFIRMATION_INVALID", "Pixel hover requires fresh screenshot coordinates.");
    }
    return { url: page.url, pixel: true, x: input.x, y: input.y };
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

  guardPixelDrag(
    input: BrowserDragInput,
    screenshotUrl: string,
  ): { fromGuard: PersonalActionGuard; toGuard: PersonalActionGuard } {
    const page = this.requirePage(input.tabId);
    if (page.url !== screenshotUrl) {
      throw new AppError("BROWSER_CONFIRMATION_INVALID", "The pixel drag belongs to a different screenshot.");
    }
    const resolve = (endpoint: BrowserDragInput["from"]): PersonalActionGuard => {
      if ("ref" in endpoint) return this.guardReference(input.tabId, endpoint.ref);
      if (!Number.isInteger(endpoint.x) || !Number.isInteger(endpoint.y)) {
        throw new AppError("INVALID_ARGUMENT", "Pixel drag endpoints must use bounded integer CSS coordinates.");
      }
      return { url: page.url, pixel: true, x: endpoint.x, y: endpoint.y };
    };
    const fromGuard = resolve(input.from);
    const toGuard = resolve(input.to);
    if (!fromGuard.pixel && !toGuard.pixel) {
      throw new AppError("INVALID_ARGUMENT", "Pixel drag confirmation is limited to pixel-only endpoints.");
    }
    const target = createHash("sha256").update(JSON.stringify([
      page.url, input.from, input.to, input.steps ?? 10,
    ])).digest("hex");
    this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
      { tabId: input.tabId, url: page.url },
      this.interactions.pageRiskCategory(page) ?? "unverified-pointer-action", "pixel-drag", "sha256:" + target,
    ));
    return { fromGuard, toGuard };
  }

  guardDrag(input: BrowserDragInput): { fromGuard: PersonalActionGuard; toGuard: PersonalActionGuard } {
    const page = this.requirePage(input.tabId);
    if (!("ref" in input.from) || !("ref" in input.to)) {
      throw new AppError("INVALID_ARGUMENT", "Coordinate drag endpoints must be resolved to fresh refs.");
    }
    const source = this.requireRef(input.tabId, input.from.ref, page);
    const target = this.requireRef(input.tabId, input.to.ref, page);
    const category = this.interactions.prepareDangerousAction(
      this.pageTab(input.tabId, page), source, "drag",
    )?.category ?? this.interactions.prepareDangerousAction(
      this.pageTab(input.tabId, page), target, "drag",
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
      this.pageTab(input.tabId, page), reference, "form-input",
    );
    if (binding) this.authorize(input.confirmationId, binding);
    return { url: page.url, ref: reference.ref, role: reference.role, name: reference.name };
  }

  guardType(input: BrowserTypeInput): PersonalActionGuard {
    const page = this.requirePage(input.tabId);
    const pageRisk = input.submit ? this.interactions.pageRiskCategory(page) ?? "submit-form" : undefined;
    if (pageRisk) {
      this.authorize(
        input.confirmationId,
        this.interactions.prepareConfirmation(
          { tabId: input.tabId, url: page.url },
          pageRisk, "type",
          "keyboard:Enter:sha256:" + createHash("sha256").update(input.text).digest("hex"),
        ),
      );
    }
    return { url: page.url };
  }

  guardPress(input: BrowserPressInput): PersonalActionGuard {
    validateBrowserKeySequence(input.key, input.repeat);
    const page = this.requirePage(input.tabId);
    const enter = containsBrowserEnterKey(input.key);
    const category = enter ? this.interactions.pageRiskCategory(page) ??
      (/(?:ctrl|control|meta|command)\+enter/iu.test(input.key) ? "send-message" : "submit-form") : undefined;
    if (category) {
      this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
        { tabId: input.tabId, url: page.url }, category, "press", "keyboard:Enter",
      ));
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
        guarded.push({ ...step, guard: step.ref
          ? this.guardReference(input.tabId, step.ref)
          : this.guardPixelHover({ ...step, tabId: input.tabId }, this.requirePage(input.tabId).url) });
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

  /**
   * Bind every dangerous legacy click/Enter target before consuming any
   * confirmation, so a missing grant for a later step never wastes an earlier one.
   */
  guardFrameSequence(
    input: BrowserFrameSequenceInput,
    targets: readonly PersonalLegacyFrameTarget[],
  ): void {
    const page = this.requirePage(input.tabId);
    const tab = this.pageTab(input.tabId, page);
    const required: Array<{
      confirmationId: string | undefined;
      binding: Parameters<BrowserConfirmationRegistry["create"]>[0];
    }> = [];
    for (const target of targets) {
      const step = input.steps[target.index];
      if (step?.action !== "click" && step?.action !== "press") {
        throw new AppError("RELAY_PROTOCOL_ERROR", "Legacy preflight target does not match a click or key step.");
      }
      if (step.action === "press") validateBrowserKeySequence(step.key);
      // A deferred target is only dispatched after a preceding waitFor. The
      // extension checks its actual semantics before input and rejects submit
      // or sensitive controls instead of authorizing an unseen target.
      if (target.deferred) {
        if (step.action !== "click" || !step.locator?.text || target.label !== step.locator.text ||
            !input.steps.slice(0, target.index).some((earlier) => earlier.action === "waitFor" &&
              earlier.locator?.text === step.locator?.text &&
              JSON.stringify(earlier.framePath ?? []) === JSON.stringify(step.framePath ?? []))) {
          throw new AppError("RELAY_PROTOCOL_ERROR", "Deferred target is not bound to a preceding wait.");
        }
        if (this.interactions.prepareDangerousTarget(tab, target.label, "legacy-click") ||
            this.interactions.pageRiskCategory(tab)) {
          throw new AppError("ACTION_BLOCKED_BY_POLICY", "Sensitive deferred target requires observation before execution.");
        }
        continue;
      }
      const action = `legacy-${step.action}`;
      const scope = `${(step.framePath ?? []).join("/")}|${target.role}:${target.label}`;
      const semanticRole = target.role.replace(/:(?:submit|image)$/u, "");
      const labelRisk = this.interactions.prepareDangerousTarget(tab, target.label,
        action, semanticRole)?.category;
      const safeQuery = target.formMethod === "get" &&
        /^(pesquisar|filtrar|consultar|exibir)$/iu.test(target.label);
      const category = labelRisk ?? ((target.submitLike || step.action === "press")
        ? this.interactions.pageRiskCategory(tab) : undefined) ??
        ((target.submitLike && !safeQuery) || step.action === "press" ? "submit-form" : undefined);
      if (!category) continue;
      required.push({
        confirmationId: step.confirmationId,
        binding: this.interactions.prepareConfirmation(tab, category, action,
          step.action === "press" ? `keyboard:Enter|${scope}` : scope),
      });
    }
    const needed = required.filter((entry) => entry.confirmationId !== undefined || !this.approvedBySite(entry.binding));
    const missing = needed.find((entry) => entry.confirmationId === undefined);
    if (missing) this.authorize(undefined, missing.binding);
    for (const entry of needed) this.authorize(entry.confirmationId, entry.binding);
  }

  /**
   * A legacy menu path needs one confirmation when any requested label is
   * dangerous; the extension separately refuses unconfirmed submit controls.
   */
  guardNavigatePath(input: BrowserNavigatePathInput): boolean {
    const page = this.requirePage(input.tabId);
    const tab = this.pageTab(input.tabId, page);
    const category = input.path
      .map((label) => this.interactions.prepareDangerousTarget(
        tab, label, "legacy-navigate-path", "legacy-menu-path")?.category)
      .find((value) => value !== undefined);
    if (!category) return false;
    const frames = input.segments
      ? input.segments.map((segment) => segment.framePath.join("/"))
      : [(input.sourceFramePath ?? []).join("/")];
    this.authorize(input.confirmationId, this.interactions.prepareConfirmation(
      tab, category, "legacy-navigate-path", `${frames.join(",")}|${input.path.join(" > ")}`,
    ));
    return true;
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
    this.siteApprovals = undefined;
  }

  private pageTab(tabId: string, page: { url: string; title?: string }): Pick<BrowserTab, "tabId" | "url" | "title"> {
    return { tabId, url: page.url, ...(page.title ? { title: page.title } : {}) };
  }

  private requirePage(tabId: string): { url: string; title?: string; refs: Set<string> } {
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

  private siteApprovable(binding: BrowserConfirmationBinding): boolean {
    return PERSONAL_SITE_APPROVABLE_CATEGORIES.has(binding.category) && !ONE_USE_ACTIONS.has(binding.action) &&
      !binding.target.startsWith("keyboard:") && /^https?:\/\//u.test(binding.origin);
  }

  private approvedBySite(binding: BrowserConfirmationBinding): boolean {
    const approvals = this.siteApprovals;
    if (!approvals || !this.siteApprovable(binding)) return false;
    const taskId = this.pages.get(binding.tabId)?.taskId;
    if (approvals.grants.some((grant) => grant.origin === binding.origin && grant.category === binding.category &&
        ("taskId" in grant ? grant.taskId === taskId : grant.tabId === binding.tabId))) return true;
    // Only an explicitly approved exact HTTPS origin may retain JavaScript permission across tasks.
    if (binding.category === "execute-script" && binding.action === "evaluate" &&
        approvals.permanentScriptOrigins?.includes(binding.origin)) return true;
    const host = new URL(binding.origin).hostname.toLowerCase();
    return approvals.autoSites.includes(host);
  }

  private authorize(confirmationId: string | undefined, binding: BrowserConfirmationBinding): void {
    if (confirmationId) {
      this.confirmations.consume(confirmationId, binding);
      return;
    }
    if (this.approvedBySite(binding)) return;
    const confirmation = this.confirmations.create(binding);
    const siteApprovable = this.siteApprovable(binding);
    if (siteApprovable) {
      this.requestSiteApproval?.({ tabId: binding.tabId, origin: binding.origin, category: binding.category });
    }
    throw new AppError(
      "ACTION_REQUIRES_CONFIRMATION",
      `Confirmation required: ${JSON.stringify({
        ...confirmation, tabId: binding.tabId,
        category: binding.category, action: binding.action, target: binding.target,
        ...(siteApprovable ? {
          siteApproval: `Alternatively the user can allow ${binding.category} on ${binding.origin} until the task ` +
            "ends from the MCP V3 Chrome notification; then retry without confirmationId.",
        } : {}),
      })}`,
    );
  }
}
