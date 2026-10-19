import { AppError } from "./errors.js";
import type { BrowserClickInput, BrowserTab } from "./browser-contracts.js";
import type {
  BrowserConfirmationBinding,
  BrowserConfirmationCategory,
} from "./browser-confirmation.js";

export function clickAuthorizationAction(
  input: Pick<BrowserClickInput, "button" | "clickCount" | "modifiers">,
): string {
  const button = input.button ?? "left";
  const count = input.clickCount ?? 1;
  const modifiers = [...new Set(input.modifiers ?? [])].sort();
  if (button === "left" && count === 1 && modifiers.length === 0) return "click";
  return `click:${button}:${count}:${modifiers.join("+")}`;
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
    tab: Pick<BrowserTab, "tabId" | "url">,
    reference: BrowserElementReference,
    action: string,
  ): BrowserConfirmationBinding | undefined {
    const category = classifyDangerousAction(reference);
    if (!category) return undefined;
    return this.prepareConfirmation(
      tab,
      category,
      action,
      `${reference.role}:${reference.name}`,
    );
  }

  prepareDangerousTarget(
    tab: Pick<BrowserTab, "tabId" | "url">,
    target: string,
    action: string,
    role = "element",
  ): BrowserConfirmationBinding | undefined {
    const category = classifyDangerousAction({
      ref: role,
      role,
      name: target,
    });
    if (!category) return undefined;
    return this.prepareConfirmation(tab, category, action, target);
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

function classifyDangerousAction(
  reference: BrowserElementReference,
): BrowserConfirmationCategory | undefined {
  const value = `${reference.role} ${reference.name}`.toLowerCase();
  if (/\b(delete|remove|cancel|terminate|unsubscribe|deactivate|excluir|remover|cancelar)\b/.test(value)) return "delete-or-cancel";
  if (/\b(buy|purchase|pay|checkout|order|comprar|pagar|pagamento|finalizar compra)\b/.test(value)) return "purchase-or-payment";
  if (/\b(send|message|email|enviar|mensagem)\b/.test(value)) return "send-message";
  if (/\b(publish|post|publicar|postar)\b/.test(value)) return "publish-content";
  if (/\b(password|credential|security|senha|credencial)\b/.test(value)) return "change-credentials";
  if (/\b(accept|agree|terms|contract|aceitar|concordo|termos|contrato)\b/.test(value)) return "accept-terms-or-contract";
  if (/\b(upload|attach|anexar|enviar arquivo)\b/.test(value)) return "upload-file";
  if (/\b(submit|save|confirm|apply|create|update|salvar|confirmar|enviar formulario)\b/.test(value)) return "submit-form";
  return undefined;
}
