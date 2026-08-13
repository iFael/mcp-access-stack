import { describe, expect, test } from "@jest/globals";
import {
  renderConsole,
  stageLabel,
  validationStateLabel,
} from "../../../../src/actions/console/renderer.js";
import type { MutableConsoleRun } from "../../../../src/actions/console/model.js";

describe("GPT Action console renderer", () => {
  test("renders the current execution state without mutating it", () => {
    const run: MutableConsoleRun = {
      runId: "MT-20260724-0011223344556677",
      workspaceId: "legacySite",
      root: "XPNet/ScriptsAd",
      objective: "Atualizar integração",
      expectedBranch: "dev",
      branch: "feature/refactor",
      status: "waiting_confirmation",
      stage: "implementation",
      progress: 60,
      summary: "Alteração pronta para validação",
      createdAtMs: Date.parse("2026-07-24T01:00:00.000Z"),
      updatedAtMs: Date.parse("2026-07-24T01:05:00.000Z"),
      expiresAtMs: Date.parse("2026-07-24T09:05:00.000Z"),
      nextSequence: 3,
      files: new Map([
        [
          "Financeiro/FIN_conc_fila.js",
          {
            path: "Financeiro/FIN_conc_fila.js",
            state: "modified",
            additions: 8,
            deletions: 2,
            updatedAt: "2026-07-24T01:04:00.000Z",
          },
        ],
      ]),
      validations: new Map([
        [
          "legacy-compat",
          {
            name: "legacy-compat",
            state: "passed",
            summary: "sem findings",
            updatedAt: "2026-07-24T01:04:30.000Z",
          },
        ],
      ]),
      approvals: new Map([
        [
          "command",
          {
            kind: "command",
            state: "required",
            label: "Comando aguardando confirmação explícita",
            updatedAt: "2026-07-24T01:04:45.000Z",
          },
        ],
      ]),
      events: [
        {
          sequence: 1,
          timestamp: "2026-07-24T01:00:00.000Z",
          kind: "run_started",
          stage: "preparation",
          status: "completed",
          label: "Execução iniciada",
        },
        {
          sequence: 2,
          timestamp: "2026-07-24T01:05:00.000Z",
          kind: "approval_updated",
          stage: "implementation",
          status: "waiting_confirmation",
          label: "Comando aguardando confirmação explícita",
        },
      ],
    };

    const markdown = renderConsole(run);

    expect(markdown).toContain("LegacySite Dev — MT-20260724-0011223344556677");
    expect(markdown).toContain("Branch: feature/refactor");
    expect(markdown).toContain("Status: aguardando autorização");
    expect(markdown).toContain("Progresso: [██████░░░░] 60%");
    expect(markdown).toContain("! Implementação");
    expect(markdown).toContain("~ Financeiro/FIN_conc_fila.js (+8 -2)");
    expect(markdown).toContain("✓ legacy-compat: aprovada — sem findings");
    expect(markdown).toContain("! Comando aguardando confirmação explícita");
    expect(stageLabel("validation")).toBe("Validação");
    expect(validationStateLabel("failed")).toBe("reprovada");
  });
});
