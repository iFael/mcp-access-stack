import { describe, expect, it, jest } from "@jest/globals";
import {
  AppError,
  CredentialSecret,
  type BrowserCredentialBroker,
} from "@vs-code-gpt/shared";
import {
  OpenAIResponsesCommandProvider,
  WindowsCredentialManagerApiKeySource,
} from "../../../src/shell/qualified/openai-responses-command-provider.js";

describe("OpenAI Responses command provider", () => {
  it("uses structured Responses API output without storing request state", async () => {
    const secret = new CredentialSecret(
      Buffer.from("openai", "utf8"),
      Buffer.from("sk-proj-fixture-secret-value-123456789", "utf8"),
    );
    const fetchFn = jest.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sk-proj-fixture-secret-value-123456789",
      );
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: "gpt-5-mini",
        store: false,
        max_output_tokens: 800,
        text: {
          format: {
            type: "json_schema",
            name: "command_planner",
            strict: true,
          },
        },
      });
      expect(payload).not.toHaveProperty("tools");
      expect(JSON.stringify(payload)).not.toContain(
        "sk-proj-fixture-secret-value-123456789",
      );
      return response({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  status: "proposal",
                  command: "git status --short",
                  shell: "cmd",
                  cwd: null,
                  confidence: 0.99,
                  reason: "safe read",
                }),
              },
            ],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAIResponsesCommandProvider({
      model: "gpt-5-mini",
      apiKeySource: { async read() { return secret; } },
      fetchFn,
      now: sequenceClock(1_000, 1_025),
    });

    await expect(
      provider.plan({
        objective: "Inspect repository status",
        preferredShell: "auto",
        context: providerContext(),
      }),
    ).resolves.toEqual({
      status: "proposal",
      command: "git status --short",
      shell: "cmd",
      confidence: 0.99,
      reason: "safe read",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(secret.username.every((value) => value === 0)).toBe(true);
    expect(secret.password.every((value) => value === 0)).toBe(true);
    expect(provider.snapshot()).toEqual({
      calls: 1,
      successes: 1,
      failures: 0,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      lastLatencyMs: 25,
    });
  });

  it("fails closed on low confidence, refusals and invalid provider endpoints", async () => {
    const provider = new OpenAIResponsesCommandProvider({
      model: "gpt-5-mini",
      apiKeySource: apiKeySource(),
      fetchFn: (async () =>
        response({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    status: "proposal",
                    command: "git status",
                    shell: "cmd",
                    cwd: null,
                    confidence: 0.5,
                    reason: null,
                  }),
                },
              ],
            },
          ],
          usage: {},
        })) as typeof fetch,
    });
    await expect(
      provider.plan({
        objective: "Inspect status",
        preferredShell: "auto",
        context: providerContext(),
      }),
    ).resolves.toEqual({ status: "none" });

    expect(
      () =>
        new OpenAIResponsesCommandProvider({
          model: "gpt-5-mini",
          endpoint: "https://attacker.invalid/v1/responses",
          apiKeySource: apiKeySource(),
        }),
    ).toThrow(AppError);
  });

  it("accounts for credential broker failures within the provider lifecycle", async () => {
    const provider = new OpenAIResponsesCommandProvider({
      model: "gpt-5-mini",
      apiKeySource: {
        async read() {
          throw new AppError(
            "CREDENTIAL_BROKER_UNAVAILABLE",
            "credential unavailable",
          );
        },
      },
      fetchFn: jest.fn() as unknown as typeof fetch,
      now: sequenceClock(2_000, 2_040),
    });

    await expect(
      provider.plan({
        objective: "Inspect status",
        preferredShell: "auto",
        context: providerContext(),
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_BROKER_UNAVAILABLE" });
    expect(provider.snapshot()).toEqual({
      calls: 1,
      successes: 0,
      failures: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastLatencyMs: 40,
    });
  });

  it("bounds response size and never exposes upstream response bodies", async () => {
    const provider = new OpenAIResponsesCommandProvider({
      model: "gpt-5-mini",
      apiKeySource: apiKeySource(),
      fetchFn: (async () =>
        new Response("private upstream error body", {
          status: 500,
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
    });

    await expect(
      provider.plan({
        objective: "Inspect status",
        preferredShell: "auto",
        context: providerContext(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "Command provider is temporarily unavailable.",
    });
    expect(provider.snapshot()).toMatchObject({ calls: 1, failures: 1 });
  });
});

describe("Windows Credential Manager API key source", () => {
  it("maps the shared credential broker result without reading environment variables", async () => {
    const credential = new CredentialSecret(
      Buffer.from("openai", "utf8"),
      Buffer.from("sk-proj-fixture-secret-value-123456789", "utf8"),
    );
    const read = jest.fn(async (_request: Parameters<BrowserCredentialBroker["read"]>[0]) => ({
      status: "success" as const,
      secret: credential,
    }));
    const broker: BrowserCredentialBroker = { read };
    const source = new WindowsCredentialManagerApiKeySource({ broker });

    await expect(source.read()).resolves.toBe(credential);
    expect(read).toHaveBeenCalledWith({
      siteId: "openai-api",
      accountId: "command-provider",
    });
  });

  it("maps access denial to a sanitized broker error", async () => {
    const broker: BrowserCredentialBroker = {
      async read() {
        return { status: "access-denied" };
      },
    };
    const source = new WindowsCredentialManagerApiKeySource({ broker });

    await expect(source.read()).rejects.toMatchObject({
      code: "CREDENTIAL_BROKER_ACCESS_DENIED",
      message: "Command provider credential access was denied.",
    });
  });
});

function apiKeySource() {
  return {
    async read() {
      return new CredentialSecret(
        Buffer.from("openai", "utf8"),
        Buffer.from("sk-proj-fixture-secret-value-123456789", "utf8"),
      );
    },
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function providerContext() {
  return {
    platform: "win32" as const,
    architecture: "x64",
    logicalCwd: ".",
    allowedShells: ["cmd" as const],
    markers: [{ path: ".git", kind: "repository" }],
    packageScripts: [],
    gitRepository: true,
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2.53" },
    ],
  };
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
