import { describe, expect, test } from "@jest/globals";
import {
  operationCompletionLabel,
  operationLabel,
  projectConsoleOperation,
  stageForOperation,
} from "../../../../src/actions/console/operation-projection.js";

describe("GPT Action console operation projection", () => {
  test("projects file, validation and Git results into declarative effects", () => {
    expect(
      projectConsoleOperation(
        "lerArquivosEmLoteDoEspacoDeTrabalho",
        { files: [{ path: "a.ts" }, { path: "b.ts" }] },
        "running",
      ),
    ).toMatchObject({
      files: [
        { path: "a.ts", state: "read" },
        { path: "b.ts", state: "read" },
      ],
    });

    expect(
      projectConsoleOperation(
        "executarValidacaoNoEspacoDeTrabalho",
        {
          validation: "secret-scan",
          executed: true,
          passed: false,
          filesScanned: 4,
        },
        "running",
      ),
    ).toMatchObject({
      minProgress: 80,
      stage: "validation",
      validations: [
        {
          name: "secret-scan",
          state: "failed",
          summary: "4 arquivo(s) verificado(s)",
        },
      ],
    });

    expect(
      projectConsoleOperation(
        "inspecionarGitDoEspacoDeTrabalho",
        {
          branch: "feature/work",
          status: [
            { path: "created.ts", indexStatus: "?", workTreeStatus: "?" },
            { path: "deleted.ts", indexStatus: "D", workTreeStatus: " " },
            { path: "changed.ts", indexStatus: " ", workTreeStatus: "M" },
          ],
        },
        "running",
      ),
    ).toMatchObject({
      branch: "feature/work",
      minProgress: 90,
      stage: "git",
      files: [
        { path: "created.ts", state: "created" },
        { path: "deleted.ts", state: "deleted" },
        { path: "changed.ts", state: "modified" },
      ],
    });
  });

  test("projects command confirmation transitions using the current run status", () => {
    expect(
      projectConsoleOperation(
        "executarComandoNoEspacoDeTrabalho",
        { status: "confirmation_required" },
        "running",
      ),
    ).toMatchObject({
      status: "waiting_confirmation",
      approval: { kind: "command", state: "required" },
    });

    expect(
      projectConsoleOperation(
        "executarComandoNoEspacoDeTrabalho",
        { status: "executed" },
        "waiting_confirmation",
      ),
    ).toMatchObject({
      status: "running",
      approval: { kind: "command", state: "approved" },
    });
  });

  test("keeps operation labels and stage mapping stable", () => {
    expect(stageForOperation("lerArquivoDoEspacoDeTrabalho")).toBe("investigation");
    expect(stageForOperation("validarAlteracoesDoEspacoDeTrabalho")).toBe("validation");
    expect(operationLabel("inspecionarGitDoEspacoDeTrabalho")).toBe("Inspecionar Git");
    expect(
      operationCompletionLabel(
        "executarPowerShellNoEspacoDeTrabalho",
        { status: "confirmation_required" },
      ),
    ).toBe("Executar PowerShell aguardando confirmação");
  });
});
