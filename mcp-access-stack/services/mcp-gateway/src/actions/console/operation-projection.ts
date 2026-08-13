import type {
  ConsoleApprovalUpdate,
  ConsoleFileState,
  ConsoleFileUpdate,
  ConsoleRunStatus,
  ConsoleStage,
  ConsoleValidationUpdate,
} from "./model.js";

const OPERATION_LABELS: Record<string, string> = {
  listarArquivosDoEspacoDeTrabalho: "Listar arquivos",
  lerArquivoDoEspacoDeTrabalho: "Ler arquivo",
  lerArquivosEmLoteDoEspacoDeTrabalho: "Ler arquivos em lote",
  buscarArquivosNoEspacoDeTrabalho: "Buscar arquivos",
  obterContextoDoEspacoDeTrabalho: "Obter contexto do projeto",
  prepararTarefaNoEspacoDeTrabalho: "Preparar tarefa",
  validarAlteracoesDoEspacoDeTrabalho: "Validar alterações",
  aplicarAlteracoesExatasNoArquivo: "Aplicar alterações exatas",
  criarOuSobrescreverArquivo: "Criar ou sobrescrever arquivo",
  executarValidacaoNoEspacoDeTrabalho: "Executar validação",
  inspecionarGitDoEspacoDeTrabalho: "Inspecionar Git",
  executarComandoNoEspacoDeTrabalho: "Executar comando",
  executarPowerShellNoEspacoDeTrabalho: "Executar PowerShell",
};

export interface ConsoleOperationProjection {
  branch?: string | undefined;
  minProgress?: number | undefined;
  stage?: ConsoleStage | undefined;
  status?: ConsoleRunStatus | undefined;
  files: ConsoleFileUpdate[];
  validations: ConsoleValidationUpdate[];
  approval?: ConsoleApprovalUpdate | undefined;
}

export function projectConsoleOperation(
  operation: string,
  result: unknown,
  currentStatus: ConsoleRunStatus,
): ConsoleOperationProjection {
  const projection: ConsoleOperationProjection = {
    files: [],
    validations: [],
  };
  const data = asRecord(result);
  if (data === undefined) return projection;

  projection.branch = stringValue(data.branch);

  if (operation === "lerArquivoDoEspacoDeTrabalho") {
    addFile(projection, stringValue(data.path), "read");
  }

  if (operation === "lerArquivosEmLoteDoEspacoDeTrabalho") {
    for (const file of arrayValue(data.files).slice(0, 50)) {
      addFile(projection, stringValue(asRecord(file)?.path), "read");
    }
  }

  if (operation === "prepararTarefaNoEspacoDeTrabalho") {
    projection.branch = stringValue(asRecord(data.git)?.branch) ?? projection.branch;
    projection.minProgress = 20;
    projection.stage = "investigation";
  }

  if (operation === "aplicarAlteracoesExatasNoArquivo") {
    const changed = booleanValue(data.changed);
    const dryRun = booleanValue(data.dryRun);
    if (changed === true && dryRun !== true) {
      addFile(projection, stringValue(data.path), "modified");
    }
    projection.minProgress = dryRun === true ? 45 : 60;
  }

  if (operation === "criarOuSobrescreverArquivo") {
    addFile(
      projection,
      stringValue(data.path),
      booleanValue(data.created) === true ? "created" : "modified",
    );
    projection.minProgress = 60;
  }

  if (operation === "executarValidacaoNoEspacoDeTrabalho") {
    const validation = stringValue(data.validation);
    if (validation !== undefined) {
      projection.validations.push({
        name: validation,
        state:
          booleanValue(data.executed) !== true
            ? "skipped"
            : booleanValue(data.passed) === true
              ? "passed"
              : "failed",
        summary: `${numberValue(data.filesScanned) ?? 0} arquivo(s) verificado(s)`,
      });
    }
    projection.minProgress = 80;
    projection.stage = "validation";
  }

  if (operation === "validarAlteracoesDoEspacoDeTrabalho") {
    const status = arrayValue(data.status);
    if (status.length > 0) {
      addGitStatusFiles(projection, status);
    } else {
      for (const path of arrayValue(data.changedPaths)
        .map(stringValue)
        .filter((value): value is string => value !== undefined)
        .slice(0, 50)) {
        addFile(projection, path, "modified");
      }
    }
    projection.validations.push({
      name: "diff-check",
      state: booleanValue(data.passed) === true ? "passed" : "failed",
    });
    projection.minProgress = 85;
    projection.stage = "validation";
  }

  if (operation === "inspecionarGitDoEspacoDeTrabalho") {
    addGitStatusFiles(projection, arrayValue(data.status));
    projection.minProgress = 90;
    projection.stage = "git";
  }

  if (
    operation === "executarComandoNoEspacoDeTrabalho" ||
    operation === "executarPowerShellNoEspacoDeTrabalho"
  ) {
    const status = stringValue(data.status);
    if (status === "confirmation_required") {
      projection.status = "waiting_confirmation";
      projection.approval = {
        kind: "command",
        state: "required",
        label: "Comando aguardando confirmação explícita",
      };
    } else if (status === "executed" && currentStatus === "waiting_confirmation") {
      projection.status = "running";
      projection.approval = {
        kind: "command",
        state: "approved",
        label: "Comando confirmado e executado",
      };
    }
  }

  return projection;
}

export function stageForOperation(operation: string): ConsoleStage {
  if (
    [
      "listarArquivosDoEspacoDeTrabalho",
      "lerArquivoDoEspacoDeTrabalho",
      "lerArquivosEmLoteDoEspacoDeTrabalho",
      "buscarArquivosNoEspacoDeTrabalho",
      "obterContextoDoEspacoDeTrabalho",
    ].includes(operation)
  ) {
    return "investigation";
  }
  if (operation === "prepararTarefaNoEspacoDeTrabalho") return "preparation";
  if (["aplicarAlteracoesExatasNoArquivo", "criarOuSobrescreverArquivo"].includes(operation)) {
    return "implementation";
  }
  if (
    [
      "executarValidacaoNoEspacoDeTrabalho",
      "validarAlteracoesDoEspacoDeTrabalho",
    ].includes(operation)
  ) {
    return "validation";
  }
  if (operation === "inspecionarGitDoEspacoDeTrabalho") return "git";
  return "implementation";
}

export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? sanitizeLabel(operation, 100);
}

export function operationCompletionLabel(operation: string, result: unknown): string {
  const data = asRecord(result);
  if (
    (operation === "executarComandoNoEspacoDeTrabalho" ||
      operation === "executarPowerShellNoEspacoDeTrabalho") &&
    stringValue(data?.status) === "confirmation_required"
  ) {
    return `${operationLabel(operation)} aguardando confirmação`;
  }
  return `${operationLabel(operation)} concluído`;
}

function addGitStatusFiles(
  projection: ConsoleOperationProjection,
  status: unknown[],
): void {
  for (const entry of status.slice(0, 50)) {
    const item = asRecord(entry);
    const path = stringValue(item?.path);
    if (path !== undefined && item !== undefined) {
      addFile(projection, path, gitFileState(item));
    }
  }
}

function addFile(
  projection: ConsoleOperationProjection,
  path: string | undefined,
  state: ConsoleFileState,
): void {
  if (path !== undefined) projection.files.push({ path, state });
}

function gitFileState(entry: Record<string, unknown>): ConsoleFileState {
  const indexStatus = stringValue(entry.indexStatus);
  const workTreeStatus = stringValue(entry.workTreeStatus);
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "?" || workTreeStatus === "?" || indexStatus === "A") {
    return "created";
  }
  return "modified";
}

function sanitizeLabel(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
