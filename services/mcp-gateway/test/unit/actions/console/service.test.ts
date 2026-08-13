import { describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { GptActionConsole } from "../../../../src/actions/console/service.js";

describe("GPT Action conversational console", () => {
  it("tracks stages, files, validations, approvals and a final textual panel", () => {
    let now = Date.parse("2026-07-22T15:00:00.000Z");
    const consoleRegistry = new GptActionConsole({ now: () => now });

    const started = consoleRegistry.start({
      workspaceId: "legacySite",
      root: "XPNet/ScriptsAd",
      objective: "Implementar o Console Conversacional",
      expectedBranch: "feat/conversational-console",
    });

    expect(started.runId).toMatch(/^MT-20260722-[A-F0-9]{16}$/u);
    expect(started).toMatchObject({
      workspaceId: "legacySite",
      root: "XPNet/ScriptsAd",
      status: "running",
      stage: "preparation",
      progress: 5,
    });
    expect(started.consoleMarkdown).toContain("LegacySite Dev —");
    expect(started.consoleMarkdown).toContain("Preparação");

    now += 1_000;
    const waiting = consoleRegistry.update({
      runId: started.runId,
      stage: "implementation",
      status: "running",
      progress: 60,
      branch: "feat/conversational-console",
      summary: "Backend do console implementado",
      files: [
        {
          path: "services/mcp-gateway/src/gpt-action-console.ts",
          state: "created",
          additions: 400,
          deletions: 0,
        },
      ],
      validations: [{ name: "typecheck", state: "running" }],
      approval: {
        kind: "commit",
        state: "required",
        label: "Commit aguardando autorização explícita",
      },
    });

    expect(waiting.status).toBe("waiting_confirmation");
    expect(waiting.files).toEqual([
      expect.objectContaining({
        path: "services/mcp-gateway/src/gpt-action-console.ts",
        state: "created",
        additions: 400,
      }),
    ]);
    expect(waiting.consoleMarkdown).toContain("aguardando autorização");
    expect(waiting.consoleMarkdown).toContain("typecheck: executando");
    expect(waiting.consoleMarkdown).toContain("Commit aguardando autorização explícita");

    now += 1_000;
    const resumed = consoleRegistry.update({
      runId: started.runId,
      status: "running",
      approval: {
        kind: "commit",
        state: "approved",
        label: "Commit autorizado",
      },
    });
    expect(resumed.status).toBe("running");

    now += 1_000;
    const finished = consoleRegistry.finish({
      runId: started.runId,
      outcome: "completed",
      summary: "Console concluído e validado",
    });
    expect(finished).toMatchObject({
      status: "completed",
      stage: "completed",
      progress: 100,
      summary: "Console concluído e validado",
    });
    expect(finished.consoleMarkdown).toContain("Status: concluída");

    expect(() =>
      consoleRegistry.finish({
        runId: started.runId,
        outcome: "completed",
      }),
    ).toThrow(expect.objectContaining({ code: "EXECUTION_STATE_INVALID" }));
  });

  it("records tool operations automatically without storing raw command or file content", () => {
    const consoleRegistry = new GptActionConsole();
    const run = consoleRegistry.start({
      workspaceId: "project",
      root: "mcp-access-stack",
      objective: "Validar rastreamento automático",
    });

    const readSequence = consoleRegistry.startOperation(
      run.runId,
      "lerArquivoDoEspacoDeTrabalho",
      "project",
    );
    consoleRegistry.completeOperation(
      run.runId,
      readSequence,
      "lerArquivoDoEspacoDeTrabalho",
      {
        path: "README.md",
        content: "conteúdo que não deve ser armazenado",
        sizeBytes: 40,
      },
    );

    const validationSequence = consoleRegistry.startOperation(
      run.runId,
      "executarValidacaoNoEspacoDeTrabalho",
      "project",
    );
    consoleRegistry.completeOperation(
      run.runId,
      validationSequence,
      "executarValidacaoNoEspacoDeTrabalho",
      {
        validation: "diff-check",
        executed: true,
        passed: true,
        filesScanned: 3,
        findings: [],
      },
    );

    const commandSequence = consoleRegistry.startOperation(
      run.runId,
      "executarComandoNoEspacoDeTrabalho",
      "project",
    );
    consoleRegistry.completeOperation(
      run.runId,
      commandSequence,
      "executarComandoNoEspacoDeTrabalho",
      {
        status: "confirmation_required",
        command: "comando-secreto-que-nao-pode-aparecer",
        reasons: ["requires confirmation"],
      },
    );

    const snapshot = consoleRegistry.get(run.runId);
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: "README.md", state: "read" }),
    ]);
    expect(snapshot.validations).toEqual([
      expect.objectContaining({ name: "diff-check", state: "passed" }),
    ]);
    expect(snapshot.status).toBe("waiting_confirmation");
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({ kind: "command", state: "required" }),
    ]);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("conteúdo que não deve ser armazenado");
    expect(serialized).not.toContain("comando-secreto-que-nao-pode-aparecer");

    const events = consoleRegistry.listEvents(run.runId, 0);
    expect(events.events.map((event) => event.kind)).toEqual([
      "run_started",
      "operation_started",
      "operation_completed",
      "operation_started",
      "operation_completed",
      "operation_started",
      "operation_completed",
    ]);
  });

  it("preserves created, modified and deleted states from structured Git status", () => {
    const consoleRegistry = new GptActionConsole();
    const run = consoleRegistry.start({
      workspaceId: "legacySite",
      root: "XPNet/ScriptsAd",
      objective: "Classificar estado Git",
    });

    const sequence = consoleRegistry.startOperation(
      run.runId,
      "inspecionarGitDoEspacoDeTrabalho",
      "legacySite",
    );
    consoleRegistry.completeOperation(
      run.runId,
      sequence,
      "inspecionarGitDoEspacoDeTrabalho",
      {
        branch: "dev",
        status: [
          { path: "novo.js", indexStatus: "?", workTreeStatus: "?" },
          { path: "alterado.js", indexStatus: " ", workTreeStatus: "M" },
          { path: "removido.js", indexStatus: "D", workTreeStatus: " " },
        ],
      },
    );

    expect(consoleRegistry.get(run.runId).files).toEqual([
      expect.objectContaining({ path: "alterado.js", state: "modified" }),
      expect.objectContaining({ path: "novo.js", state: "created" }),
      expect.objectContaining({ path: "removido.js", state: "deleted" }),
    ]);
  });

  it("rejects cross-workspace tracking and expires in-memory executions", () => {
    let now = 1_000;
    const consoleRegistry = new GptActionConsole({
      now: () => now,
      ttlMs: 100,
    });
    const run = consoleRegistry.start({
      workspaceId: "legacySite",
      root: "XPNet/ScriptsAd",
      objective: "Testar isolamento",
    });

    expect(() =>
      consoleRegistry.startOperation(
        run.runId,
        "lerArquivoDoEspacoDeTrabalho",
        "project",
      ),
    ).toThrow(expect.objectContaining({ code: "EXECUTION_STATE_INVALID" }));

    now += 101;
    try {
      consoleRegistry.get(run.runId);
      throw new Error("Expected expired run lookup to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("EXECUTION_NOT_FOUND");
    }
  });
});
