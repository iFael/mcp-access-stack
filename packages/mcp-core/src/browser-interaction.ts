import { AppError } from "./errors.js";
import type { BrowserClickInput, BrowserTab } from "./browser-contracts.js";
import type {
  BrowserConfirmationBinding,
  BrowserConfirmationCategory,
} from "./browser-confirmation.js";

export function clickAuthorizationAction(
  input: Pick<BrowserClickInput, "button" | "clickCount" | "modifiers" | "x" | "y">,
): string {
  const button = input.button ?? "left";
  const count = input.clickCount ?? 1;
  const modifiers = [...new Set(input.modifiers ?? [])].sort();
  const variant = button === "left" && count === 1 && modifiers.length === 0 ? "click" : `click:${button}:${count}:${modifiers.join("+")}`;
  return input.x === undefined || input.y === undefined ? variant : `${variant}:point:${input.x},${input.y}`;
}

/** Detect an Enter action anywhere in a Playwright-compatible key chord/sequence. */
export function containsBrowserEnterKey(key: string): boolean {
  return key.trim().split(/\s+/u).some((chord) => {
    const last = chord.split("+").at(-1);
    return last !== undefined && /^(?:enter|return|numpadenter)$/iu.test(last);
  });
}

/** Refuse a repeated submit and ensure bounded keyboard operations. */
export function validateBrowserKeySequence(key: string, repeat = 1): void {
  const chords = key.trim().split(/\s+/u);
  if (!chords.every(Boolean) || chords.length * repeat > 100) {
    throw new AppError("LIMIT_EXCEEDED", "Browser keyboard sequence exceeds 100 actions.");
  }
  if (repeat > 1 && containsBrowserEnterKey(key)) {
    throw new AppError("ACTION_BLOCKED_BY_POLICY", "Repeating Enter can submit a form multiple times.");
  }
}

export interface BrowserElementReference {
  ref: string;
  role: string;
  name: string;
}

/** Rank only authenticated snapshot references. The page remains untrusted data. */
export function findBrowserElements(
  references: readonly BrowserElementReference[],
  query: string,
  role?: string,
  limit = 10,
): Array<BrowserElementReference & { score: number }> {
  const normalized = normalizeFindText(query);
  if (!normalized || limit < 1) return [];
  const words = normalized.split(" ");
  const normalizedRole = role?.toLowerCase();
  return references.flatMap((reference, index) => {
    if (normalizedRole && reference.role.toLowerCase() !== normalizedRole) return [];
    const name = normalizeFindText(reference.name);
    if (!name || !words.every((word) => name.includes(word))) return [];
    const score = name === normalized ? 100 : name.startsWith(normalized) ? 90
      : name.includes(normalized) ? 80 : 60;
    return [{ ...reference, score, index }];
  }).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(limit, 20))
    .map(({ index: _index, ...reference }) => reference);
}

function normalizeFindText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .replace(/[-\u2010-\u2015]/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .replace(/\s+/gu, " ");
}

export class BrowserInteractionContextService {
  private readonly references = new Map<
    string,
    Map<string, BrowserElementReference>
  >();

  captureReferences(
    tabId: string,
    content: string,
  ): BrowserElementReference[] {
    const references = parseElementReferences(content);
    this.references.set(
      tabId,
      new Map(references.map((reference) => [reference.ref, reference])),
    );
    return references;
  }

  captureStructuredReferences(
    tabId: string,
    references: readonly BrowserElementReference[],
  ): void {
    this.references.set(
      tabId,
      new Map(references.map((reference) => [
        reference.ref, { ref: reference.ref, role: reference.role, name: reference.name },
      ])),
    );
  }

  mergeReferences(
    tabId: string,
    content: string,
  ): BrowserElementReference[] {
    const existing = this.references.get(tabId) ??
      new Map<string, BrowserElementReference>();
    for (const reference of parseElementReferences(content)) {
      existing.set(reference.ref, reference);
    }
    this.references.set(tabId, existing);
    return [...existing.values()];
  }

  currentReferences(tabId: string): BrowserElementReference[] {
    return [...(this.references.get(tabId)?.values() ?? [])];
  }

  requireReference(tabId: string, ref: string): BrowserElementReference {
    const reference = this.references.get(tabId)?.get(ref);
    if (!reference) {
      throw new AppError(
        "INVALID_ARGUMENT",
        `Unknown element reference ${ref}. Capture a fresh browser_snapshot first.`,
      );
    }
    return reference;
  }

  discardReferences(tabId: string): void {
    this.references.delete(tabId);
  }

  clearReferences(): number {
    let removed = 0;
    for (const references of this.references.values()) {
      removed += references.size;
    }
    this.references.clear();
    return removed;
  }

  assertBusinessReadOnlyReference(
    tabId: string,
    ref: string,
    action: string,
  ): void {
    const reference = this.requireReference(tabId, ref);
    this.assertBusinessReadOnlyTarget(
      reference.role + ":" + reference.name,
      action,
      reference.role,
    );
  }

  assertBusinessReadOnlyTarget(
    target: string,
    action: string,
    role = "element",
  ): void {
    const category = classifyDangerousAction({ ref: role, role, name: target });
    if (!category) return;
    throw new AppError(
      "ACTION_BLOCKED_BY_POLICY",
      "Business read-only policy blocked " + action + " on a " + category + " control.",
    );
  }

  prepareDangerousAction(
    tab: Pick<BrowserTab, "tabId" | "url" | "title">,
    reference: BrowserElementReference,
    action: string,
  ): BrowserConfirmationBinding | undefined {
    const category = classifyDangerousAction(reference, tab);
    if (!category) return undefined;
    return this.prepareConfirmation(
      tab,
      category,
      action,
      `${reference.role}:${reference.name}`,
    );
  }

  prepareDangerousTarget(
    tab: Pick<BrowserTab, "tabId" | "url" | "title">,
    target: string,
    action: string,
    role = "element",
  ): BrowserConfirmationBinding | undefined {
    const category = classifyDangerousAction({
      ref: role,
      role,
      name: target,
    }, tab);
    if (!category) return undefined;
    return this.prepareConfirmation(tab, category, action, target);
  }

  /**
   * What submitting anything on this page amounts to when the page itself is a
   * checkout, an account deletion or a security page; undefined elsewhere.
   */
  pageRiskCategory(tab: Pick<BrowserTab, "url" | "title">): BrowserConfirmationCategory | undefined {
    return classifyPageContext(tab);
  }

  prepareConfirmation(
    tab: Pick<BrowserTab, "tabId" | "url">,
    category: BrowserConfirmationCategory,
    action: string,
    target: string,
  ): BrowserConfirmationBinding {
    const url = tab.url ?? "about:blank";
    let origin = "null";
    try {
      origin = new URL(url).origin;
    } catch {
      // Non-HTTP pages intentionally use a null origin.
    }
    return { tabId: tab.tabId, origin, url, category, action, target };
  }
}

function parseElementReferences(content: string): BrowserElementReference[] {
  const references: BrowserElementReference[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    line = line.slice(2).trim();
    line = line.replace(/^<[^>]+>\s+/u, "");

    const refMatch = /\[ref=([^\]]+)\]/u.exec(line);
    if (!refMatch?.[1]) continue;
    const beforeRef = line.slice(0, refMatch.index).trim();
    const withoutState = beforeRef.replace(/(?:\s+\[(?!ref=)[^\]]+\])+\s*$/u, "").trim();
    const roleMatch = /^([A-Za-z][\w-]*)(?:\s+(.*))?$/u.exec(withoutState);
    if (!roleMatch?.[1]) continue;

    const rawName = (roleMatch[2] ?? "").trim();
    let name = rawName;
    if ((rawName.startsWith('"') && rawName.endsWith('"')) ||
        (rawName.startsWith("'") && rawName.endsWith("'"))) {
      name = rawName.slice(1, -1);
    }
    references.push({
      role: roleMatch[1],
      name: name.trim(),
      ref: refMatch[1],
    });
  }
  return references;
}

function foldText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

// Generic "go on" controls carry no risk in their label; the page decides.
const PROCEED_LABEL =
  /\b(continue|next|ok|yes|confirm|finish|done|proceed|submit|continuar|proximo|sim|confirmar|finalizar|concluir|prosseguir|avancar)\b/u;
// Links only navigate; the controls that pay, delete or save are buttons.
const CLICKABLE_ROLE = /button|menuitem|submit/u;

/**
 * The page a control sits on: checkout, account deletion or security pages,
 * read from the address (host label and path) and the title.
 */
function classifyPageContext(
  context: Pick<BrowserTab, "url" | "title"> | undefined,
): BrowserConfirmationCategory | undefined {
  let place = "";
  try {
    const url = new URL(context?.url ?? "");
    place = url.hostname.split(".")[0] + " " + decodeURIComponent(url.pathname);
  } catch {
    // An unparsable address adds nothing; the title may still say enough.
  }
  const text = foldText(place + " " + (context?.title ?? "")).replace(/[-_/.+]+/gu, " ");
  if (/\b(delete|deactivate|terminate|unsubscribe|cancel|close account|close my account|excluir|apagar|encerrar|desativar|cancelar|descadastrar)\b/u.test(text)) {
    return "delete-or-cancel";
  }
  if (/\b(checkout|payment|payments|pay|billing|cart|basket|pagamento|pagar|carrinho|pix|boleto|finalizar compra|place order|revisar pedido)\b/u.test(text)) {
    return "purchase-or-payment";
  }
  if (/\b(password|security|2fa|mfa|credentials|senha|seguranca)\b/u.test(text)) return "change-credentials";
  return undefined;
}

function classifyDangerousAction(
  reference: BrowserElementReference,
  context?: Pick<BrowserTab, "url" | "title">,
): BrowserConfirmationCategory | undefined {
  const value = foldText(`${reference.role} ${reference.name}`);
  const byLabel = classifyDangerousLabel(value);
  // A control that only saves or goes on is as risky as the page it is on:
  // "Confirmar" on a checkout is a payment, "Continue" on a close-account page
  // deletes it. Such pages are never approved per site.
  if (byLabel && byLabel !== "submit-form") return byLabel;
  if (byLabel === "submit-form" ||
      (CLICKABLE_ROLE.test(reference.role.toLowerCase()) && PROCEED_LABEL.test(value))) {
    return classifyPageContext(context) ?? byLabel;
  }
  return byLabel;
}

function classifyDangerousLabel(value: string): BrowserConfirmationCategory | undefined {
  if (/\b(delete|remove|cancel|terminate|unsubscribe|deactivate|excluir|remover|cancelar|apagar|encerrar|desativar|descadastrar)\b/.test(value)) return "delete-or-cancel";
  if (/\b(buy|purchase|pay|checkout|order|subscribe|donate|comprar|pagar|pagamento|finalizar compra|assinar|contratar|doar)\b/.test(value) ||
      /\btransfer/.test(value) ||
      /\b(fazer|finalizar|confirmar|concluir|efetuar|enviar) pedido\b/.test(value)) return "purchase-or-payment";
  if (/\b(send|message|email|enviar|mensagem)\b/.test(value)) return "send-message";
  if (/\b(publish|post|publicar|postar)\b/.test(value)) return "publish-content";
  if (/\b(password|credential|security|senha|credencial)\b/.test(value)) return "change-credentials";
  if (/\b(accept|agree|terms|contract|aceitar|concordo|termos|contrato)\b/.test(value)) return "accept-terms-or-contract";
  if (/\b(upload|attach|anexar|enviar arquivo)\b/.test(value)) return "upload-file";
  if (/\b(submit|save|confirm|apply|create|update|salvar|confirmar|enviar formulario)\b/.test(value)) return "submit-form";
  return undefined;
}
