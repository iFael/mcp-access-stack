import { createHash } from "node:crypto";
import { describe, expect, it, jest } from "@jest/globals";
import type { BrowserExecutor } from "@vs-code-gpt/shared";
import { createGatewayApplication } from "../../../src/app.js";
import type { GatewayConfig } from "../../../src/config.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const ACTION_TOKEN = "project-and-legacySite-action-token-for-tests";
const ACTION_TOKEN_SHA256 = createHash("sha256")
  .update(ACTION_TOKEN, "utf8")
  .digest("hex");

const actionOverrides: Partial<GatewayConfig> = {
  actions: {
    tokenSha256: ACTION_TOKEN_SHA256,
    workspaceIds: ["workspace-a", "workspace-b"],
    allowWrite: true,
    allowShell: true,
  },
};

describe("GPT Actions REST facade", () => {
  it("publishes an OpenAPI schema for the closed Project and LegacySite allowlist", async () => {
    const fixture = await createActionsFixture();
    try {
      const schemaResponse = await fetch(
        new URL("/mcp/actions/openapi.json", fixture.url),
      );
      const schema = await schemaResponse.json() as {
        info: { title: string; version: string };
        servers: Array<{ url: string }>;
        paths: Record<string, unknown>;
        components: {
          securitySchemes: Record<string, unknown>;
          schemas: Record<
            string,
            {
              properties?: Record<string, { enum?: string[] }>;
              required?: string[];
              additionalProperties?: boolean;
            }
          >;
        };
      };

      expect(schemaResponse.status).toBe(200);
      expect(schema.info).toMatchObject({
        title: "Project and LegacySite MCP Action Bridge",
        version: "1.7.0",
      });
      expect(schema.servers).toEqual([
        { url: "http://127.0.0.1/mcp/actions/v1" },
      ]);
      expect(Object.keys(schema.paths)).toEqual([
        "/console/runs/start",
        "/console/runs/update",
        "/console/runs/get",
        "/console/runs/events",
        "/console/runs/finish",
        "/workspaces",
        "/files/list",
        "/files/read",
        "/files/read-batch",
        "/files/search",
        "/workspace/context",
        "/workspace/prepare",
        "/workspace/validate",
        "/files/patch",
        "/files/write",
        "/workspace/validation/run",
        "/git/diff",
        "/shell/run",
        "/shell/powershell",
      ]);
      const operationIds = Object.values(schema.paths).flatMap((pathItem) =>
        Object.values(
          pathItem as Record<string, { operationId: string }>,
        ).map(({ operationId }) => operationId),
      );
      expect(operationIds).toEqual([
        "iniciarConsoleConversacional",
        "atualizarConsoleConversacional",
        "consultarConsoleConversacional",
        "listarEventosDoConsoleConversacional",
        "concluirConsoleConversacional",
        "listarEspacosDeTrabalhoAutorizados",
        "listarArquivosDoEspacoDeTrabalho",
        "lerArquivoDoEspacoDeTrabalho",
        "lerArquivosEmLoteDoEspacoDeTrabalho",
        "buscarArquivosNoEspacoDeTrabalho",
        "obterContextoDoEspacoDeTrabalho",
        "prepararTarefaNoEspacoDeTrabalho",
        "validarAlteracoesDoEspacoDeTrabalho",
        "aplicarAlteracoesExatasNoArquivo",
        "criarOuSobrescreverArquivo",
        "executarValidacaoNoEspacoDeTrabalho",
        "inspecionarGitDoEspacoDeTrabalho",
        "executarComandoNoEspacoDeTrabalho",
        "executarPowerShellNoEspacoDeTrabalho",
      ]);
      expect(schema.components.securitySchemes).toHaveProperty("actionBearer");
      expect(
        schema.components.schemas.ReadFileInput?.properties?.workspaceId?.enum,
      ).toEqual(["workspace-a", "workspace-b"]);
      expect(
        Object.keys(
          schema.components.schemas.WorkspaceContextResult?.properties ?? {},
        ),
      ).toEqual([
        "workspaceId",
        "rootPath",
        "instructionFiles",
        "availableInstructionFiles",
        "skills",
        "git",
      ]);
      expect(
        schema.components.schemas.WorkspaceContextResult?.additionalProperties,
      ).toBe(false);
      expect(schema.components.schemas.ReadFileResult?.required).toEqual([
        "path",
        "content",
        "startLine",
        "endLine",
        "totalLines",
        "sizeBytes",
        "sha256",
        "encoding",
        "lineEnding",
      ]);
      expect(schema.components.schemas.WorkspaceGitResult?.required).toEqual([
        "workspaceId",
        "root",
        "branch",
        "diffMode",
        "status",
        "staged",
        "unstaged",
        "truncated",
      ]);
      expect(schema.components.schemas).toHaveProperty("ReadFilesInput");
      expect(schema.components.schemas).toHaveProperty("PatchFileInput");
      expect(schema.components.schemas).toHaveProperty("PrepareWorkspaceTaskInput");
      expect(schema.components.schemas).toHaveProperty("ValidateWorkspaceChangesInput");
      expect(schema.components.schemas).toHaveProperty("RunWorkspaceValidationInput");
      expect(schema.components.schemas).toHaveProperty("RunWorkspaceValidationResult");
      expect(schema.components.schemas).toHaveProperty("StartConsoleRunInput");
      expect(schema.components.schemas).toHaveProperty("UpdateConsoleRunInput");
      expect(schema.components.schemas).toHaveProperty("ConsoleRunResult");
      expect(schema.components.schemas).toHaveProperty("ConsoleEventsResult");
      expect(
        schema.components.schemas.ReadFileInput?.properties?.runId,
      ).toMatchObject({ pattern: "^MT-[0-9]{8}-[A-F0-9]{16}$" });
      expect(
        Object.keys(schema.components.schemas.WorkspaceGitResult?.properties ?? {}),
      ).toEqual(["workspaceId", "root", "branch", "diffMode", "status", "staged", "unstaged", "truncated"]);
      expect(
        schema.components.schemas.WorkspaceGitResult?.additionalProperties,
      ).toBe(false);
      expect(JSON.stringify(schema)).not.toContain(ACTION_TOKEN);
      expect(JSON.stringify(schema)).not.toContain(ACTION_TOKEN_SHA256);

      const privacy = await fetch(new URL("/mcp/actions/privacy", fixture.url));
      expect(privacy.status).toBe(200);
      expect(privacy.headers.get("content-type")).toContain("text/html");
      expect(await privacy.text()).toContain("Project e LegacySite");
    } finally {
      await fixture.close();
    }
  });

  it("manages a conversational console lifecycle entirely through the Action", async () => {
    const fixture = await createActionsFixture();
    try {
      const startedResponse = await postAction(
        fixture.url,
        "/console/runs/start",
        {
          workspaceId: "workspace-b",
          root: "XPNet/ScriptsAd",
          objective: "Implementar uma alteração auditável",
          expectedBranch: "dev",
        },
        ACTION_TOKEN,
      );
      expect(startedResponse.status).toBe(200);
      const started = await startedResponse.json() as {
        runId: string;
        status: string;
        progress: number;
        consoleMarkdown: string;
      };
      expect(started.runId).toMatch(/^MT-\d{8}-[A-F0-9]{16}$/u);
      expect(started).toMatchObject({ status: "running", progress: 5 });
      expect(started.consoleMarkdown).toContain("LegacySite Dev —");

      const updatedResponse = await postAction(
        fixture.url,
        "/console/runs/update",
        {
          runId: started.runId,
          stage: "implementation",
          progress: 60,
          summary: "Alteração implementada",
          files: [
            {
              path: "Financeiro/FIN_conc_fila.js",
              state: "modified",
              additions: 8,
              deletions: 2,
            },
          ],
          validations: [{ name: "legacy-compat", state: "passed" }],
          approval: {
            kind: "commit",
            state: "required",
            label: "Commit aguardando autorização",
          },
        },
        ACTION_TOKEN,
      );
      expect(updatedResponse.status).toBe(200);
      const updated = await updatedResponse.json() as {
        status: string;
        files: Array<{ path: string }>;
        consoleMarkdown: string;
      };
      expect(updated.status).toBe("waiting_confirmation");
      expect(updated.files).toEqual([
        expect.objectContaining({ path: "Financeiro/FIN_conc_fila.js" }),
      ]);
      expect(updated.consoleMarkdown).toContain("Commit aguardando autorização");

      const eventsResponse = await postAction(
        fixture.url,
        "/console/runs/events",
        { runId: started.runId, afterSequence: 0 },
        ACTION_TOKEN,
      );
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json() as {
        events: Array<{ kind: string }>;
        nextSequence: number;
      };
      expect(events.events.map((event) => event.kind)).toContain("run_started");
      expect(events.events.map((event) => event.kind)).toContain("file_updated");
      expect(events.nextSequence).toBeGreaterThan(0);

      const finishedResponse = await postAction(
        fixture.url,
        "/console/runs/finish",
        {
          runId: started.runId,
          outcome: "completed",
          summary: "Tarefa concluída",
        },
        ACTION_TOKEN,
      );
      expect(finishedResponse.status).toBe(200);
      await expect(finishedResponse.json()).resolves.toMatchObject({
        status: "completed",
        stage: "completed",
        progress: 100,
      });
      expect(fixture.finishTask).toHaveBeenCalledTimes(1);
      expect(fixture.finishTask).toHaveBeenCalledWith({});

      const invalidUpdate = await postAction(
        fixture.url,
        "/console/runs/update",
        { runId: started.runId, progress: 90 },
        ACTION_TOKEN,
      );
      expect(invalidUpdate.status).toBe(409);
      await expect(invalidUpdate.json()).resolves.toMatchObject({
        error: { code: "EXECUTION_STATE_INVALID" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("records failures from existing actions when a console run id is supplied", async () => {
    const fixture = await createActionsFixture();
    try {
      const startedResponse = await postAction(
        fixture.url,
        "/console/runs/start",
        {
          workspaceId: "workspace-a",
          root: "mcp-access-stack",
          objective: "Rastrear uma leitura indisponível",
        },
        ACTION_TOKEN,
      );
      const started = await startedResponse.json() as { runId: string };

      const readResponse = await postAction(
        fixture.url,
        "/files/read",
        {
          runId: started.runId,
          workspaceId: "workspace-a",
          path: "README.md",
        },
        ACTION_TOKEN,
      );
      expect(readResponse.status).toBe(503);

      const consoleResponse = await postAction(
        fixture.url,
        "/console/runs/get",
        { runId: started.runId },
        ACTION_TOKEN,
      );
      expect(consoleResponse.status).toBe(200);
      const snapshot = await consoleResponse.json() as {
        events: Array<{ kind: string; label: string }>;
      };
      expect(snapshot.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "operation_started" }),
          expect.objectContaining({
            kind: "operation_failed",
            label: expect.stringContaining("AGENT_UNAVAILABLE"),
          }),
        ]),
      );

      const missing = await postAction(
        fixture.url,
        "/console/runs/get",
        { runId: "MT-20260722-ABCDEF0123456789" },
        ACTION_TOKEN,
      );
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({
        error: { code: "EXECUTION_NOT_FOUND" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("requires the dedicated bearer token", async () => {
    const fixture = await createActionsFixture();
    try {
      const missing = await postAction(fixture.url, "/files/read", {
        workspaceId: "workspace-b",
        path: "README.md",
      });
      expect(missing.status).toBe(401);
      await expect(missing.json()).resolves.toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" },
      });

      const invalid = await postAction(
        fixture.url,
        "/files/read",
        { workspaceId: "workspace-a", path: "README.md" },
        "wrong-token",
      );
      expect(invalid.status).toBe(401);
    } finally {
      await fixture.close();
    }
  });

  it("rejects workspaces outside the configured allowlist before calling the agent", async () => {
    const fixture = await createActionsFixture();
    try {
      const response = await postAction(
        fixture.url,
        "/files/read",
        { workspaceId: "development", path: "README.md" },
        ACTION_TOKEN,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "PERMISSION_DENIED" },
      });
    } finally {
      await fixture.close();
    }
  });

  it.each(["workspace-a", "workspace-b"] as const)(
    "forwards authorized %s operations to the local-agent relay",
    async (workspaceId) => {
      const fixture = await createActionsFixture();
      try {
        const response = await postAction(
          fixture.url,
          "/files/read",
          { workspaceId, path: "README.md" },
          ACTION_TOKEN,
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "AGENT_UNAVAILABLE" },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps Action bearer authentication separate from MCP OAuth authentication", async () => {
    const fixture = await createActionsFixture();
    try {
      const response = await postAction(
        fixture.url,
        "/files/read",
        { workspaceId: "workspace-b", path: "README.md" },
        ACTION_TOKEN,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("omits write, Git and shell operations when they are disabled", async () => {
    const fixture = await createActionsFixture({
      actions: {
        tokenSha256: ACTION_TOKEN_SHA256,
        workspaceIds: ["workspace-a", "workspace-b"],
        allowWrite: false,
        allowShell: false,
      },
    });
    try {
      const response = await fetch(
        new URL("/mcp/actions/openapi.json", fixture.url),
      );
      const schema = await response.json() as { paths: Record<string, unknown> };

      expect(schema.paths).not.toHaveProperty("/files/patch");
      expect(schema.paths).not.toHaveProperty("/files/write");
      expect(schema.paths).not.toHaveProperty("/workspace/validation/run");
      expect(schema.paths).not.toHaveProperty("/git/diff");
      expect(schema.paths).not.toHaveProperty("/shell/run");
      expect(schema.paths).not.toHaveProperty("/shell/powershell");
    } finally {
      await fixture.close();
    }
  });
});

async function createActionsFixture(
  overrides: Partial<GatewayConfig> = actionOverrides,
) {
  const finishTask = jest.fn<BrowserExecutor["finishTask"]>(async (_input) => ({
    completed: true as const,
    closedTabs: 1,
    browserClosed: true,
  }));
  const gateway = createGatewayApplication(makeGatewayConfig(overrides), {
    logger: silentLogger(),
    tokenVerifier: { verify: async () => { throw new Error("not used"); } },
    browser: { finishTask } as unknown as BrowserExecutor,
  });
  const http = await listen(gateway.app);
  return {
    ...http,
    finishTask,
    close: async () => {
      gateway.relay!.close();
      await http.close();
    },
  };
}

function postAction(
  url: URL,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return fetch(new URL(`/mcp/actions/v1${path}`, url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}
