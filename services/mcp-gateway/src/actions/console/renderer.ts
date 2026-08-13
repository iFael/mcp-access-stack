import {
  consoleStageValues,
  type ConsoleApprovalState,
  type ConsoleEvent,
  type ConsoleFileState,
  type ConsoleRunStatus,
  type ConsoleStage,
  type ConsoleValidationState,
  type MutableConsoleRun,
} from "./model.js";

const STAGE_RANK = new Map<ConsoleStage, number>(
  consoleStageValues.map((stage, index) => [stage, index]),
);

export function renderConsole(run: MutableConsoleRun): string {
  const barLength = 10;
  const filled = Math.round((run.progress / 100) * barLength);
  const bar = `${"█".repeat(filled)}${"░".repeat(barLength - filled)}`;
  const lines = [
    `LegacySite Dev — ${run.runId}`,
    "",
    `Workspace: ${run.workspaceId}`,
    `Raiz: ${run.root}`,
    `Branch: ${run.branch ?? run.expectedBranch ?? "não identificada"}`,
    `Status: ${statusLabel(run.status)}`,
    `Progresso: [${bar}] ${run.progress}%`,
    "",
    `Objetivo: ${run.objective}`,
  ];
  if (run.summary) lines.push(`Resumo: ${run.summary}`);

  lines.push("", "Etapas");
  for (const stage of consoleStageValues) {
    lines.push(`${stageMarker(run, stage)} ${stageLabel(stage)}`);
  }

  lines.push("", "Atividade");
  const recentEvents = run.events.slice(-8);
  if (recentEvents.length === 0) {
    lines.push("— Nenhuma atividade registrada");
  } else {
    for (const event of recentEvents) {
      lines.push(`${timeLabel(event.timestamp)}  ${eventMarker(event.status)} ${event.label}`);
    }
  }

  lines.push("", "Arquivos");
  const files = [...run.files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (files.length === 0) {
    lines.push("— Nenhum arquivo registrado");
  } else {
    for (const file of files.slice(0, 20)) {
      const counts =
        file.additions === undefined && file.deletions === undefined
          ? ""
          : ` (+${file.additions ?? 0} -${file.deletions ?? 0})`;
      lines.push(`${fileMarker(file.state)} ${file.path}${counts}`);
    }
    if (files.length > 20) lines.push(`… e mais ${files.length - 20} arquivo(s)`);
  }

  lines.push("", "Validações");
  const validations = [...run.validations.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (validations.length === 0) {
    lines.push("— Nenhuma validação registrada");
  } else {
    for (const validation of validations) {
      const summary = validation.summary ? ` — ${validation.summary}` : "";
      lines.push(
        `${validationMarker(validation.state)} ${validation.name}: ${validationStateLabel(validation.state)}${summary}`,
      );
    }
  }

  const approvals = [...run.approvals.values()];
  if (approvals.length > 0) {
    lines.push("", "Autorizações");
    for (const approval of approvals) {
      lines.push(`${approvalMarker(approval.state)} ${approval.label}`);
    }
  }

  return lines.join("\n");
}

export function stageLabel(stage: ConsoleStage): string {
  const labels: Record<ConsoleStage, string> = {
    preparation: "Preparação",
    investigation: "Investigação",
    implementation: "Implementação",
    validation: "Validação",
    git: "Git",
    completed: "Conclusão",
  };
  return labels[stage];
}

export function validationStateLabel(state: ConsoleValidationState): string {
  const labels: Record<ConsoleValidationState, string> = {
    pending: "pendente",
    running: "executando",
    passed: "aprovada",
    failed: "reprovada",
    skipped: "não executada",
  };
  return labels[state];
}

function stageMarker(run: MutableConsoleRun, stage: ConsoleStage): string {
  if (run.status === "completed") return "✓";
  const currentRank = STAGE_RANK.get(run.stage) ?? 0;
  const stageRank = STAGE_RANK.get(stage) ?? 0;
  if (stageRank < currentRank) return "✓";
  if (stage === run.stage) return run.status === "waiting_confirmation" ? "!" : "●";
  return "○";
}

function eventMarker(status: ConsoleEvent["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "waiting_confirmation") return "!";
  return "●";
}

function fileMarker(state: ConsoleFileState): string {
  if (state === "created") return "+";
  if (state === "deleted") return "−";
  if (state === "read") return "·";
  return "~";
}

function validationMarker(state: ConsoleValidationState): string {
  if (state === "passed") return "✓";
  if (state === "failed") return "✗";
  if (state === "running") return "●";
  if (state === "skipped") return "−";
  return "○";
}

function approvalMarker(state: ConsoleApprovalState): string {
  if (state === "approved") return "✓";
  if (state === "rejected") return "✗";
  return "!";
}

function statusLabel(status: ConsoleRunStatus): string {
  const labels: Record<ConsoleRunStatus, string> = {
    running: "executando",
    waiting_confirmation: "aguardando autorização",
    completed: "concluída",
    failed: "falhou",
    cancelled: "cancelada",
  };
  return labels[status];
}

function timeLabel(value: string): string {
  return value.slice(11, 19);
}
