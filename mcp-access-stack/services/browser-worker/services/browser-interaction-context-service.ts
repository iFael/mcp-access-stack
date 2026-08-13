import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import type {
  BrowserConfirmationBinding,
  BrowserConfirmationCategory,
} from "../domain/confirmation-registry.js";

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
    tab: BrowserTab,
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
    tab: BrowserTab,
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
    tab: BrowserTab,
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
  const pattern = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+(?:"([^"]*)"|'([^']*)'|([^\[]+?)))?(?:\s+\[(?!ref=)[^\]]+\])*\s+\[ref=([^\]]+)\]/gm;
  for (const match of content.matchAll(pattern)) {
    references.push({
      role: match[1] ?? "element",
      name: (match[2] ?? match[3] ?? match[4] ?? "").trim(),
      ref: match[5] ?? "",
    });
  }
  return references.filter((reference) => reference.ref.length > 0);
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
