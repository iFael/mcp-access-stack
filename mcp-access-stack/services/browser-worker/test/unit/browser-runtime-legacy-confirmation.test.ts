import { describe, expect, it } from "@jest/globals";
import {
  AppError,
  type BrowserFrameSequenceInput,
  type BrowserTab,
} from "@vs-code-gpt/shared";
import { BrowserConfirmationRegistry } from "../../domain/confirmation-registry.js";
import { BrowserSitePolicyRegistry } from "../../domain/authorized-site-policy.js";
import { BrowserInteractionContextService } from "../../services/browser-interaction-context-service.js";
import { BrowserRuntime } from "../../services/browser-runtime.js";

describe("BrowserRuntime legacy confirmation flow", () => {
  it("converts a DOM policy block into a bound confirmation and consumes it on retry", async () => {
    const tab = makeTab();
    const calls: number[] = [];
    const runtime = Object.create(BrowserRuntime.prototype) as BrowserRuntime;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      tabsRegistry: {
        assertMcpOwned: () => tab,
        reconfigureMcp: (_tabId: string, changes: Partial<BrowserTab>) =>
          Object.assign(tab, changes),
      },
      tabBindings: {
        syncUnifiedTab: () => undefined,
      },
      interactionContext: new BrowserInteractionContextService(),
      confirmations: new BrowserConfirmationRegistry(),
      sitePolicies: new BrowserSitePolicyRegistry([]),
      legacyAutomation: {
        frameSequence: async (
          _input: BrowserFrameSequenceInput,
          authorizedSteps: ReadonlySet<number>,
        ) => {
          calls.push(authorizedSteps.size);
          if (!authorizedSteps.has(0)) {
            throw new AppError(
              "ACTION_BLOCKED_BY_POLICY",
              'Legacy action requires explicit confirmation: {"kind":"step","index":0,"risk":"submit","target":"Analisar"}',
            );
          }
          return {
            result: {
              completed: true,
              steps: [
                {
                  index: 0,
                  action: "click",
                  completed: true,
                  strategy: "id",
                  ref: "lref_submit",
                },
              ],
              telemetry: { totalMs: 1, retries: 0 },
            },
            response: { text: "", sections: new Map() },
          };
        },
      },
      selectTab: async () => undefined,
      beginNavigation: async () => undefined,
      updateSelectedTab: () => tab,
      checkpoint: async () => undefined,
    });

    const input: BrowserFrameSequenceInput = {
      tabId: tab.tabId,
      steps: [
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { id: "analisar" },
        },
      ],
    };

    const firstError = await captureAppError(runtime.frameSequence(input));
    expect(firstError.code).toBe("ACTION_REQUIRES_CONFIRMATION");
    const confirmation = parseConfirmation(firstError.message);
    expect(confirmation).toMatchObject({
      category: "submit-form",
      action: "legacy-click",
      target: "Analisar",
    });

    const result = await runtime.frameSequence({
      ...input,
      steps: [
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { id: "analisar" },
          confirmationId: confirmation.confirmationId,
        },
      ],
    });

    expect(result).toMatchObject({
      tabId: tab.tabId,
      completed: true,
      steps: [{ action: "click", completed: true }],
    });
    expect(calls).toEqual([0, 0, 1]);
  });
});

async function captureAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError.");
}

function parseConfirmation(message: string): {
  confirmationId: string;
  category: string;
  action: string;
  target: string;
} {
  const marker = "Confirmation required: ";
  const offset = message.indexOf(marker);
  if (offset < 0) throw new Error("Confirmation payload was not found.");
  return JSON.parse(message.slice(offset + marker.length)) as {
    confirmationId: string;
    category: string;
    action: string;
    target: string;
  };
}

function makeTab(): BrowserTab {
  const now = new Date().toISOString();
  return {
    tabId: "tab-legacy-confirmation",
    ownership: "mcp",
    purpose: "legacy-confirmation-test",
    reusable: false,
    protected: false,
    sticky: false,
    createdAt: now,
    lastUsedAt: now,
    url: "https://example.test/legacy",
    title: "Legacy fixture",
  };
}
