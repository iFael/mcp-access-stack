import type { GatewayActionsConfig, GatewayConfig } from "../config.js";

export function createGptActionsOpenApi(
  config: GatewayConfig,
  actions: GatewayActionsConfig,
): Record<string, unknown> {
  const basePath = `${config.mcpPath}/actions`;
  const serverUrl = new URL(`${basePath}/v1`, config.publicBaseUrl).href.replace(
    /\/$/,
    "",
  );
  const paths: Record<string, unknown> = {
    "/console/runs/start": {
      post: operation(
        "iniciarConsoleConversacional",
        "Inicia uma execução do Console Conversacional. Use esta operação no começo de toda tarefa de investigação ou alteração e reutilize o runId retornado nas demais ações.",
        false,
        "StartConsoleRunInput",
        refResponse("ConsoleRunResult"),
      ),
    },
    "/console/runs/update": {
      post: operation(
        "atualizarConsoleConversacional",
        "Atualiza etapa, progresso, resumo, branch, arquivos, validações ou autorização pendente da execução. Retorna consoleMarkdown pronto para apresentação no chat.",
        false,
        "UpdateConsoleRunInput",
        refResponse("ConsoleRunResult"),
      ),
    },
    "/console/runs/get": {
      post: operation(
        "consultarConsoleConversacional",
        "Consulta o estado atual de uma execução e retorna o painel textual consolidado em consoleMarkdown.",
        false,
        "GetConsoleRunInput",
        refResponse("ConsoleRunResult"),
      ),
    },
    "/console/runs/events": {
      post: operation(
        "listarEventosDoConsoleConversacional",
        "Lista eventos incrementais e sanitizados de uma execução. Não retorna conteúdo de arquivos, diffs, comandos ou segredos.",
        false,
        "ListConsoleEventsInput",
        refResponse("ConsoleEventsResult"),
      ),
    },
    "/console/runs/finish": {
      post: operation(
        "concluirConsoleConversacional",
        "Finaliza a execução como concluída, falha ou cancelada e retorna o painel textual final.",
        false,
        "FinishConsoleRunInput",
        refResponse("ConsoleRunResult"),
      ),
    },
    "/workspaces": {
      get: operation(
        "listarEspacosDeTrabalhoAutorizados",
        "Lista os espaços de trabalho autorizados para esta Action privada do GPT.",
        false,
        undefined,
        arrayResponse("WorkspaceSummary"),
      ),
    },
    "/files/list": {
      post: operation(
        "listarArquivosDoEspacoDeTrabalho",
        "Lista arquivos em um espaço de trabalho autorizado. Os caminhos são relativos à raiz selecionada.",
        false,
        "ListFilesInput",
        refResponse("ListFilesResult"),
      ),
    },
    "/files/read": {
      post: operation(
        "lerArquivoDoEspacoDeTrabalho",
        "Lê um arquivo de texto inteiro ou um intervalo de linhas em um espaço de trabalho autorizado.",
        false,
        "ReadFileInput",
        refResponse("ReadFileResult"),
      ),
    },
    "/files/read-batch": {
      post: operation(
        "lerArquivosEmLoteDoEspacoDeTrabalho",
        "Lê em lote até dez arquivos de texto conhecidos ou intervalos de linhas. Cada resultado inclui SHA-256, encoding e final de linha.",
        false,
        "ReadFilesInput",
        refResponse("ReadFilesResult"),
      ),
    },
    "/files/search": {
      post: operation(
        "buscarArquivosNoEspacoDeTrabalho",
        "Busca uma string literal nos arquivos de um espaço de trabalho autorizado.",
        false,
        "SearchFilesInput",
        refResponse("SearchFilesResult"),
      ),
    },
    "/workspace/context": {
      post: operation(
        "obterContextoDoEspacoDeTrabalho",
        "Obtém arquivos de instrução e contexto Git para um caminho em um espaço de trabalho autorizado.",
        false,
        "WorkspaceContextInput",
        refResponse("WorkspaceContextResult"),
      ),
    },
    "/workspace/prepare": {
      post: operation(
        "prepararTarefaNoEspacoDeTrabalho",
        "Prepara uma tarefa coletando contexto do projeto, inspeção Git resumida e documentos de instrução ou configuração aplicáveis.",
        false,
        "PrepareWorkspaceTaskInput",
        refResponse("PrepareWorkspaceTaskResult"),
      ),
    },
    "/workspace/validate": {
      post: operation(
        "validarAlteracoesDoEspacoDeTrabalho",
        "Valida alterações do repositório: branch, caminhos alterados, regras de escopo, whitespace do Git, diff e metadados de arquivos de texto. Esta operação não executa testes.",
        false,
        "ValidateWorkspaceChangesInput",
        refResponse("ValidateWorkspaceChangesResult"),
      ),
    },
  };

  if (actions.allowWrite) {
    paths["/files/patch"] = {
      post: operation(
        "aplicarAlteracoesExatasNoArquivo",
        "Aplica substituições exatas em um arquivo de texto existente. Exige o SHA-256 da leitura atual, preserva encoding e finais de linha e permite simulação.",
        true,
        "PatchFileInput",
        refResponse("PatchFileResult"),
      ),
    };
    paths["/files/write"] = {
      post: operation(
        "criarOuSobrescreverArquivo",
        "Cria ou sobrescreve um arquivo de texto em um espaço de trabalho autorizado. Inspecione contexto, status Git e diff antes da gravação.",
        true,
        "WriteFileInput",
        refResponse("WriteFileResult"),
      ),
    };
  }

  if (actions.allowShell) {
    paths["/workspace/validation/run"] = {
      post: operation(
        "executarValidacaoNoEspacoDeTrabalho",
        "Executa uma validação predefinida e somente leitura. As validações disponíveis são diff-check, legacy-format, legacy-compat e secret-scan; comandos arbitrários não são aceitos.",
        false,
        "RunWorkspaceValidationInput",
        refResponse("RunWorkspaceValidationResult"),
      ),
    };
    paths["/git/diff"] = {
      post: operation(
        "inspecionarGitDoEspacoDeTrabalho",
        "Inspeciona branch e status Git, com diffs opcionais resumidos ou completos e filtros por caminho. Para o LegacySite, use a raiz XPNet/ScriptsAd.",
        false,
        "WorkspaceGitInput",
        refResponse("WorkspaceGitResult"),
      ),
    };
    paths["/shell/run"] = {
      post: operation(
        "executarComandoNoEspacoDeTrabalho",
        "Executa um comando em um shell permitido dentro de um espaço de trabalho autorizado. Pushes envolvendo main são bloqueados permanentemente; pushes para outras branches exigem confirmação explícita do usuário.",
        true,
        "RunCommandInput",
        refResponse("CommandResult"),
      ),
    };
    paths["/shell/powershell"] = {
      post: operation(
        "executarPowerShellNoEspacoDeTrabalho",
        "Executa um comando PowerShell dentro de um espaço de trabalho autorizado. Pushes envolvendo main são bloqueados permanentemente; pushes para outras branches exigem confirmação explícita do usuário.",
        true,
        "RunPowerShellInput",
        refResponse("CommandResult"),
      ),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Project and LegacySite MCP Action Bridge",
      version: "1.7.0",
      description:
        "Private REST facade over the MCP Access Stack with an in-chat conversational execution console. The server accepts only the configured Project and LegacySite workspace allowlist and continues enforcing local-agent filesystem, shell and confirmation policies.",
    },
    servers: [{ url: serverUrl }],
    security: [{ actionBearer: [] }],
    paths,
    components: {
      securitySchemes: {
        actionBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque-api-key",
        },
      },
      schemas: openApiSchemas(actions.workspaceIds),
    },
  };
}

function operation(
  operationId: string,
  description: string,
  consequential: boolean,
  requestSchema: string | undefined,
  responseSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operationId,
    summary: description,
    description,
    "x-openai-isConsequential": consequential,
    ...(requestSchema === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${requestSchema}` },
              },
            },
          },
        }),
    responses: {
      "200": {
        description: "Successful operation.",
        content: { "application/json": { schema: responseSchema } },
      },
      default: {
        description: "Operation failed.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ActionError" },
          },
        },
      },
    },
  };
}

function refResponse(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` };
}

function arrayResponse(name: string): Record<string, unknown> {
  return { type: "array", items: refResponse(name) };
}

function objectSchema(
  required: string[],
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function openApiSchemas(workspaceIds: readonly string[]): Record<string, unknown> {
  const workspaceId = {
    type: "string",
    enum: [...workspaceIds],
    description:
      "Authorized workspace. Use project for repositories stored under the Project folder and legacySite for the separate LegacySite ERP repository.",
  };
  const relativePath = {
    type: "string",
    minLength: 1,
    description:
      "Path relative to the selected workspace root. Never prefix it with the workspace id.",
  };
  const consoleRunId = {
    type: "string",
    pattern: "^MT-[0-9]{8}-[A-F0-9]{16}$",
    description:
      "Optional active Console Conversacional run id. Start a run first and reuse this id so the operation is recorded automatically.",
  };
  const consoleRunReference = { runId: consoleRunId };
  const commandProperties = {
    ...consoleRunReference,
    workspaceId,
    command: { type: "string", minLength: 1, maxLength: 32_000 },
    cwd: relativePath,
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: 300_000,
      default: 60_000,
    },
    confirmationId: { type: "string", minLength: 1, maxLength: 128 },
  };

  return {
    ActionError: objectSchema(["error"], {
      error: objectSchema(["code", "message", "requestId"], {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
        lifecycle: objectSchema(
          [
            "requestedTimeoutMs",
            "effectiveTimeoutMs",
            "deadlineAt",
            "elapsedMs",
          ],
          {
            requestedTimeoutMs: { type: "integer", minimum: 1 },
            effectiveTimeoutMs: { type: "integer", minimum: 0 },
            deadlineAt: { type: "string", format: "date-time" },
            elapsedMs: { type: "integer", minimum: 0 },
            terminatedBy: { type: "string" },
            reason: {
              type: "string",
              enum: [
                "timeout",
                "cancelled",
                "client_disconnected",
                "upstream_timeout",
                "process_failed",
              ],
            },
            diagnostic: { type: "string", maxLength: 500 },
          },
        ),
      }),
    }),
    StartConsoleRunInput: objectSchema(
      ["workspaceId", "objective"],
      {
        workspaceId,
        root: {
          ...relativePath,
          default: ".",
          description:
            "Repository or task root relative to the workspace. Use XPNet/ScriptsAd for LegacySite development.",
        },
        objective: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Concise task objective without secrets or file contents.",
        },
        expectedBranch: { type: "string", minLength: 1, maxLength: 200 },
      },
    ),
    UpdateConsoleRunInput: objectSchema(["runId"], {
      runId: consoleRunId,
      stage: {
        type: "string",
        enum: [
          "preparation",
          "investigation",
          "implementation",
          "validation",
          "git",
          "completed",
        ],
      },
      status: {
        type: "string",
        enum: ["running", "waiting_confirmation"],
      },
      progress: { type: "integer", minimum: 0, maximum: 100 },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Sanitized operational summary; never include secrets or raw commands.",
      },
      branch: { type: "string", minLength: 1, maxLength: 200 },
      files: {
        type: "array",
        maxItems: 20,
        items: objectSchema(["path", "state"], {
          path: relativePath,
          state: {
            type: "string",
            enum: ["read", "modified", "created", "deleted"],
          },
          additions: { type: "integer", minimum: 0 },
          deletions: { type: "integer", minimum: 0 },
        }),
      },
      validations: {
        type: "array",
        maxItems: 10,
        items: objectSchema(["name", "state"], {
          name: { type: "string", minLength: 1, maxLength: 100 },
          state: {
            type: "string",
            enum: ["pending", "running", "passed", "failed", "skipped"],
          },
          summary: { type: "string", minLength: 1, maxLength: 300 },
        }),
      },
      approval: objectSchema(["kind", "state", "label"], {
        kind: {
          type: "string",
          enum: ["commit", "push", "command", "deploy", "other"],
        },
        state: {
          type: "string",
          enum: ["required", "approved", "rejected"],
        },
        label: { type: "string", minLength: 1, maxLength: 300 },
      }),
    }),
    GetConsoleRunInput: objectSchema(["runId"], {
      runId: consoleRunId,
    }),
    ListConsoleEventsInput: objectSchema(["runId"], {
      runId: consoleRunId,
      afterSequence: {
        type: "integer",
        minimum: 0,
        default: 0,
      },
    }),
    FinishConsoleRunInput: objectSchema(["runId", "outcome"], {
      runId: consoleRunId,
      outcome: {
        type: "string",
        enum: ["completed", "failed", "cancelled"],
      },
      summary: { type: "string", minLength: 1, maxLength: 500 },
    }),
    ConsoleEvent: objectSchema(
      ["sequence", "timestamp", "kind", "stage", "status", "label"],
      {
        sequence: { type: "integer", minimum: 1 },
        timestamp: { type: "string", format: "date-time" },
        kind: {
          type: "string",
          enum: [
            "run_started",
            "stage_updated",
            "operation_started",
            "operation_completed",
            "operation_failed",
            "file_updated",
            "validation_updated",
            "approval_updated",
            "run_finished",
          ],
        },
        stage: {
          type: "string",
          enum: [
            "preparation",
            "investigation",
            "implementation",
            "validation",
            "git",
            "completed",
          ],
        },
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "waiting_confirmation"],
        },
        operation: { type: "string" },
        label: { type: "string" },
      },
    ),
    ConsoleFile: objectSchema(["path", "state", "updatedAt"], {
      path: { type: "string" },
      state: {
        type: "string",
        enum: ["read", "modified", "created", "deleted"],
      },
      additions: { type: "integer", minimum: 0 },
      deletions: { type: "integer", minimum: 0 },
      updatedAt: { type: "string", format: "date-time" },
    }),
    ConsoleValidation: objectSchema(["name", "state", "updatedAt"], {
      name: { type: "string" },
      state: {
        type: "string",
        enum: ["pending", "running", "passed", "failed", "skipped"],
      },
      summary: { type: "string" },
      updatedAt: { type: "string", format: "date-time" },
    }),
    ConsoleApproval: objectSchema(
      ["kind", "state", "label", "updatedAt"],
      {
        kind: {
          type: "string",
          enum: ["commit", "push", "command", "deploy", "other"],
        },
        state: {
          type: "string",
          enum: ["required", "approved", "rejected"],
        },
        label: { type: "string" },
        updatedAt: { type: "string", format: "date-time" },
      },
    ),
    ConsoleRunResult: objectSchema(
      [
        "runId",
        "workspaceId",
        "root",
        "objective",
        "status",
        "stage",
        "progress",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "files",
        "validations",
        "approvals",
        "events",
        "consoleMarkdown",
      ],
      {
        runId: consoleRunId,
        workspaceId,
        root: { type: "string" },
        objective: { type: "string" },
        expectedBranch: { type: "string" },
        branch: { type: "string" },
        status: {
          type: "string",
          enum: [
            "running",
            "waiting_confirmation",
            "completed",
            "failed",
            "cancelled",
          ],
        },
        stage: {
          type: "string",
          enum: [
            "preparation",
            "investigation",
            "implementation",
            "validation",
            "git",
            "completed",
          ],
        },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        files: {
          type: "array",
          items: { $ref: "#/components/schemas/ConsoleFile" },
        },
        validations: {
          type: "array",
          items: { $ref: "#/components/schemas/ConsoleValidation" },
        },
        approvals: {
          type: "array",
          items: { $ref: "#/components/schemas/ConsoleApproval" },
        },
        events: {
          type: "array",
          items: { $ref: "#/components/schemas/ConsoleEvent" },
        },
        consoleMarkdown: {
          type: "string",
          description:
            "Ready-to-render textual console. Present it directly in the chat after meaningful stage changes.",
        },
      },
    ),
    ConsoleEventsResult: objectSchema(
      [
        "runId",
        "afterSequence",
        "nextSequence",
        "truncated",
        "events",
        "consoleMarkdown",
      ],
      {
        runId: consoleRunId,
        afterSequence: { type: "integer", minimum: 0 },
        nextSequence: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
        events: {
          type: "array",
          items: { $ref: "#/components/schemas/ConsoleEvent" },
        },
        consoleMarkdown: { type: "string" },
      },
    ),
    WorkspaceSummary: objectSchema(
      [
        "id",
        "name",
        "enabled",
        "permissionProfile",
        "writesEnabled",
        "shellsEnabled",
        "allowedShells",
      ],
      {
        id: workspaceId,
        name: { type: "string" },
        enabled: { type: "boolean" },
        permissionProfile: { type: "string" },
        writesEnabled: { type: "boolean" },
        shellsEnabled: { type: "boolean" },
        allowedShells: { type: "array", items: { type: "string" } },
      },
    ),
    ListFilesInput: objectSchema(["workspaceId"], {
      ...consoleRunReference,
      workspaceId,
      root: relativePath,
      glob: { type: "string", minLength: 1 },
    }),
    ListFilesResult: objectSchema(["files", "truncated"], {
      files: { type: "array", items: { type: "string" } },
      truncated: { type: "boolean" },
    }),
    ReadFileInput: objectSchema(["workspaceId", "path"], {
      ...consoleRunReference,
      workspaceId,
      path: relativePath,
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    }),
    ReadFileResult: objectSchema(
      [
        "path",
        "content",
        "startLine",
        "endLine",
        "totalLines",
        "sizeBytes",
        "sha256",
        "encoding",
        "lineEnding",
      ],
      {
        path: { type: "string" },
        content: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        totalLines: { type: "integer", minimum: 0 },
        sizeBytes: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        encoding: {
          type: "string",
          enum: ["utf-8", "utf-16le", "utf-16be", "windows-1252", "latin1"],
        },
        lineEnding: {
          type: "string",
          enum: ["lf", "crlf", "cr", "mixed", "none"],
        },
      },
    ),
    ReadFilesInput: objectSchema(["workspaceId", "files"], {
      ...consoleRunReference,
      workspaceId,
      files: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: objectSchema(["path"], {
          path: relativePath,
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        }),
      },
      maxTotalBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_000_000,
        default: 500_000,
      },
    }),
    ReadFilesResult: objectSchema(["workspaceId", "files", "totalBytes"], {
      workspaceId,
      files: { type: "array", items: { $ref: "#/components/schemas/ReadFileResult" } },
      totalBytes: { type: "integer", minimum: 0 },
    }),
    SearchFilesInput: objectSchema(["workspaceId", "query"], {
      ...consoleRunReference,
      workspaceId,
      query: { type: "string", minLength: 1 },
      root: relativePath,
      glob: { type: "string", minLength: 1 },
      caseSensitive: { type: "boolean", default: false },
    }),
    SearchFilesResult: objectSchema(
      ["matches", "truncated", "skippedFiles"],
      {
        matches: {
          type: "array",
          items: objectSchema(["path", "line", "column", "snippet"], {
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            column: { type: "integer", minimum: 1 },
            snippet: { type: "string" },
          }),
        },
        truncated: { type: "boolean" },
        skippedFiles: { type: "integer", minimum: 0 },
      },
    ),
    WorkspaceContextInput: objectSchema(["workspaceId"], {
      ...consoleRunReference,
      workspaceId,
      root: relativePath,
    }),
    WorkspaceContextResult: objectSchema(
      [
        "workspaceId",
        "rootPath",
        "instructionFiles",
        "availableInstructionFiles",
        "skills",
        "git",
      ],
      {
        workspaceId,
        rootPath: { type: "string" },
        instructionFiles: {
          type: "array",
          items: objectSchema(["name", "path", "exists"], {
            name: { type: "string" },
            path: { type: "string" },
            exists: { type: "boolean", enum: [true] },
          }),
        },
        availableInstructionFiles: {
          type: "array",
          items: { type: "string" },
        },
        skills: {
          type: "array",
          items: objectSchema(["name", "skillFilePath", "source"], {
            name: { type: "string" },
            skillFilePath: { type: "string" },
            source: {
              type: "string",
              enum: ["project-cursor", "project-pi"],
            },
          }),
        },
        git: objectSchema(["isGitRepository"], {
          isGitRepository: { type: "boolean" },
          currentBranch: { type: "string" },
          isDirty: { type: "boolean" },
          suggestedWorktreeRoot: { type: "string" },
        }),
      },
    ),
    PatchFileInput: objectSchema(
      ["workspaceId", "path", "expectedSha256", "replacements"],
      {
        ...consoleRunReference,
        workspaceId,
        path: relativePath,
        expectedSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: objectSchema(["oldText", "newText"], {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            expectedCount: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          }),
        },
        dryRun: { type: "boolean", default: false },
      },
    ),
    PatchFileResult: objectSchema(
      [
        "path",
        "sha256Before",
        "sha256After",
        "encoding",
        "lineEnding",
        "replacementsApplied",
        "sizeBytes",
        "changed",
        "dryRun",
      ],
      {
        path: { type: "string" },
        sha256Before: { type: "string" },
        sha256After: { type: "string" },
        encoding: { type: "string" },
        lineEnding: { type: "string" },
        replacementsApplied: { type: "integer", minimum: 0 },
        sizeBytes: { type: "integer", minimum: 0 },
        changed: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
    ),
    PrepareWorkspaceTaskInput: objectSchema(["workspaceId"], {
      ...consoleRunReference,
      workspaceId,
      root: {
        ...relativePath,
        default: ".",
        description:
          "Task root relative to the workspace. For LegacySite development, use XPNet/ScriptsAd.",
      },
      targetPaths: {
        type: "array",
        maxItems: 20,
        default: [],
        items: relativePath,
      },
      intent: { type: "string", enum: ["inspect", "change"], default: "inspect" },
      includeDocumentContents: { type: "boolean", default: true },
      maxDocumentBytes: {
        type: "integer",
        minimum: 1,
        maximum: 500_000,
        default: 200_000,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 300_000,
        default: 60_000,
      },
    }),
    PrepareWorkspaceTaskResult: objectSchema(
      [
        "workspaceId",
        "root",
        "intent",
        "targetPaths",
        "context",
        "git",
        "recommendedReads",
        "documents",
        "omittedDocuments",
        "warnings",
      ],
      {
        workspaceId,
        root: { type: "string" },
        intent: { type: "string", enum: ["inspect", "change"] },
        targetPaths: { type: "array", items: { type: "string" } },
        context: { $ref: "#/components/schemas/WorkspaceContextResult" },
        git: { $ref: "#/components/schemas/WorkspaceGitResult" },
        recommendedReads: { type: "array", items: { type: "string" } },
        documents: {
          type: "array",
          items: { $ref: "#/components/schemas/ReadFileResult" },
        },
        omittedDocuments: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
      },
    ),
    ValidateWorkspaceChangesInput: objectSchema(["workspaceId"], {
      ...consoleRunReference,
      workspaceId,
      root: {
        ...relativePath,
        default: ".",
        description:
          "Repository root relative to the workspace. For LegacySite development, use XPNet/ScriptsAd.",
      },
      paths: { type: "array", maxItems: 20, items: relativePath },
      allowedPathPrefixes: { type: "array", maxItems: 20, items: relativePath },
      forbiddenPathPrefixes: {
        type: "array",
        maxItems: 20,
        default: [],
        items: relativePath,
      },
      expectedBranch: { type: "string", minLength: 1 },
      maxDiffBytes: {
        type: "integer",
        minimum: 1,
        maximum: 80_000,
        default: 60_000,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 300_000,
        default: 60_000,
      },
    }),
    ValidateWorkspaceChangesResult: objectSchema(
      [
        "workspaceId",
        "root",
        "branch",
        "passed",
        "changedPaths",
        "status",
        "staged",
        "unstaged",
        "truncated",
        "diffCheck",
        "fileMetadata",
        "testsExecuted",
        "issues",
        "warnings",
      ],
      {
        workspaceId,
        root: { type: "string" },
        branch: { type: "string" },
        passed: { type: "boolean" },
        changedPaths: { type: "array", items: { type: "string" } },
        status: {
          type: "array",
          items: { $ref: "#/components/schemas/GitStatusEntry" },
        },
        staged: { type: "string" },
        unstaged: { type: "string" },
        truncated: { type: "boolean" },
        diffCheck: objectSchema(["passed", "stdout", "stderr"], {
          passed: { type: "boolean" },
          stdout: { type: "string" },
          stderr: { type: "string" },
        }),
        fileMetadata: {
          type: "array",
          items: objectSchema(
            ["path", "sha256", "encoding", "lineEnding", "sizeBytes"],
            {
              path: { type: "string" },
              sha256: { type: "string" },
              encoding: { type: "string" },
              lineEnding: { type: "string" },
              sizeBytes: { type: "integer", minimum: 0 },
            },
          ),
        },
        testsExecuted: { type: "boolean", enum: [false] },
        issues: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
      },
    ),
    RunWorkspaceValidationInput: objectSchema(
      ["workspaceId", "validation"],
      {
        ...consoleRunReference,
        workspaceId,
        root: {
          ...relativePath,
          default: ".",
          description:
            "Validation root relative to the workspace. Use XPNet/ScriptsAd for LegacySite.",
        },
        validation: {
          type: "string",
          enum: ["diff-check", "legacy-format", "legacy-compat", "secret-scan"],
        },
        scope: {
          type: "string",
          enum: ["changes", "paths", "repository"],
          default: "changes",
        },
        paths: {
          type: "array",
          maxItems: 20,
          default: [],
          items: relativePath,
        },
        maxFindings: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 100,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 300_000,
          default: 60_000,
        },
      },
    ),
    RunWorkspaceValidationResult: objectSchema(
      [
        "workspaceId",
        "root",
        "validation",
        "scope",
        "executed",
        "passed",
        "tool",
        "filesScanned",
        "findings",
        "findingsCount",
        "truncated",
        "durationMs",
        "issues",
        "warnings",
      ],
      {
        workspaceId,
        root: { type: "string" },
        validation: {
          type: "string",
          enum: ["diff-check", "legacy-format", "legacy-compat", "secret-scan"],
        },
        scope: { type: "string", enum: ["changes", "paths", "repository"] },
        executed: { type: "boolean" },
        passed: { type: "boolean" },
        tool: objectSchema(["name", "available"], {
          name: { type: "string" },
          version: { type: "string" },
          available: { type: "boolean" },
        }),
        filesScanned: { type: "integer", minimum: 0 },
        findings: {
          type: "array",
          items: objectSchema(
            ["ruleId", "severity", "message", "path", "source"],
            {
              ruleId: { type: "string" },
              severity: { type: "string", enum: ["info", "warning", "error"] },
              message: { type: "string" },
              path: { type: "string" },
              line: { type: "integer", minimum: 1 },
              column: { type: "integer", minimum: 1 },
              source: { type: "string", enum: ["git", "format", "ast-grep", "gitleaks"] },
              fingerprint: { type: "string" },
            },
          ),
        },
        findingsCount: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
        durationMs: { type: "integer", minimum: 0 },
        issues: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
      },
    ),
    WriteFileInput: objectSchema(["workspaceId", "path", "content"], {
      ...consoleRunReference,
      workspaceId,
      path: relativePath,
      content: { type: "string" },
    }),
    WriteFileResult: objectSchema(["path", "sizeBytes", "created"], {
      path: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      created: { type: "boolean" },
    }),
    GitStatusEntry: objectSchema(
      ["path", "indexStatus", "workTreeStatus"],
      {
        path: { type: "string" },
        indexStatus: { type: "string" },
        workTreeStatus: { type: "string" },
        originalPath: { type: "string" },
      },
    ),
    WorkspaceGitInput: objectSchema(["workspaceId"], {
      ...consoleRunReference,
      workspaceId,
      root: {
        ...relativePath,
        default: ".",
        description:
          "Repository root relative to the selected workspace. Use XPNet/ScriptsAd for LegacySite; for Project, provide the internal repository folder.",
      },
      diffMode: {
        type: "string",
        enum: ["none", "summary", "full"],
        default: "summary",
      },
      paths: { type: "array", maxItems: 20, items: relativePath },
      maxDiffBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_000_000,
        default: 40_000,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 300_000,
        default: 60_000,
      },
    }),
    WorkspaceGitResult: objectSchema(
      [
        "workspaceId",
        "root",
        "branch",
        "diffMode",
        "status",
        "staged",
        "unstaged",
        "truncated",
      ],
      {
        workspaceId,
        root: { type: "string" },
        branch: {
          type: "string",
          minLength: 1,
          description: "Current branch name, or HEAD when the repository is detached.",
        },
        diffMode: { type: "string", enum: ["none", "summary", "full"] },
        status: {
          type: "array",
          items: { $ref: "#/components/schemas/GitStatusEntry" },
        },
        staged: { type: "string" },
        unstaged: { type: "string" },
        truncated: { type: "boolean" },
      },
    ),
    RunCommandInput: objectSchema(["workspaceId", "command", "shell"], {
      ...commandProperties,
      shell: {
        type: "string",
        enum: ["powershell", "pwsh", "cmd", "wsl", "git-bash"],
      },
    }),
    RunPowerShellInput: objectSchema(
      ["workspaceId", "command"],
      commandProperties,
    ),
    CommandResult: {
      oneOf: [
        objectSchema(
          ["status", "shell", "cwd", "exitCode", "stdout", "stderr", "timedOut"],
          {
            status: { type: "string", enum: ["executed"] },
            shell: { type: "string" },
            cwd: { type: "string" },
            exitCode: { type: ["integer", "null"] },
            stdout: { type: "string" },
            stderr: { type: "string" },
            timedOut: { type: "boolean" },
          },
        ),
        objectSchema(
          ["status", "shell", "cwd", "confirmationId", "expiresAt", "reasons"],
          {
            status: { type: "string", enum: ["confirmation_required"] },
            shell: { type: "string" },
            cwd: { type: "string" },
            confirmationId: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            reasons: { type: "array", items: { type: "string" } },
          },
        ),
      ],
    },
  };
}

export function createPrivacyPolicyHtml(hostname: string): string {
  const escapedHostname = escapeHtml(hostname);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Política de privacidade — MCP Action Bridge</title>
</head>
<body>
  <main>
    <h1>Política de privacidade</h1>
    <p>Esta API privada é operada pelo proprietário do domínio ${escapedHostname} para conectar um GPT pessoal aos workspaces locais Project e LegacySite.</p>
    <p>Os dados enviados são usados exclusivamente para executar operações solicitadas nos workspaces autorizados. O gateway não persiste conteúdo de arquivos, resultados de busca, diffs, comandos ou valores de arquivos em logs funcionais.</p>
    <p>Logs operacionais podem registrar metadados sanitizados, como identificador da requisição, operação, duração, código de resultado e métricas técnicas. Segredos, tokens e conteúdo de arquivos não devem ser registrados.</p>
    <p>O Console Conversacional mantém temporariamente em memória apenas metadados operacionais sanitizados, como etapa, progresso, caminhos relativos, validações e autorizações. Ele não armazena conteúdo de arquivos, diffs, comandos, stdout, stderr ou credenciais; os registros expiram automaticamente e são descartados quando o gateway reinicia.</p>
    <p>O acesso é protegido por uma chave de API privada, uma allowlist fechada de workspaces e as políticas do agente local. A API não deve ser compartilhada ou publicada.</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
