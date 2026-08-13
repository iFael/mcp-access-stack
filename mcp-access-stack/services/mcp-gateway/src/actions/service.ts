import {
  asAppError,
  type BrowserExecutor,
  getWorkspaceContextInputSchema,
  inspectGitInputSchema,
  listFilesInputSchema,
  patchFileInputSchema,
  readFileInputSchema,
  runWorkspaceValidationInputSchema,
  runCommandInputSchema,
  runPowerShellInputSchema,
  searchFilesInputSchema,
  writeFileInputSchema,
} from "@vs-code-gpt/shared";
import express, { type Express } from "express";
import type { Logger } from "pino";
import type { AgentRelay } from "../relay/service.js";
import type { GatewayConfig } from "../config.js";
import { GptActionConsole } from "./console/service.js";
import {
  createGptActionsOpenApi,
  createPrivacyPolicyHtml,
} from "./openapi.js";
import { RelayWorkspaceExecutor } from "../relay/workspace-executor.js";
import {
  assertWorkspaceAllowed,
  createActionHandler,
  createWorkspacePostHandler,
  trackConsole,
  withoutConsoleRunId,
} from "./handler.js";
import {
  createActionAuthenticationMiddleware,
  createActionLifecycleMiddleware,
  createActionRateLimiter,
  sendActionError,
  type ActionRequest,
} from "./http.js";
import {
  finishConsoleRunInputSchema,
  getConsoleRunInputSchema,
  listConsoleEventsInputSchema,
  listFilesActionInputSchema,
  patchFileActionInputSchema,
  prepareWorkspaceTaskInputSchema,
  readFileActionInputSchema,
  readFilesActionInputSchema,
  runCommandActionInputSchema,
  runPowerShellActionInputSchema,
  runWorkspaceValidationActionInputSchema,
  searchFilesActionInputSchema,
  startConsoleRunInputSchema,
  updateConsoleRunInputSchema,
  validateWorkspaceChangesInputSchema,
  workspaceContextActionInputSchema,
  workspaceGitInputSchema,
  workspaceGitResultSchema,
  writeFileActionInputSchema,
} from "./schemas.js";
import {
  prepareWorkspaceTask,
  readWorkspaceFiles,
  validateWorkspaceChanges,
} from "./workspace-workflows.js";


export function mountGptActions(
  app: Express,
  config: GatewayConfig,
  relay: AgentRelay,
  logger: Logger,
  browser?: BrowserExecutor,
): void {
  const actions = config.actions;
  if (!actions) return;

  const basePath = `${config.mcpPath}/actions`;
  const executor = new RelayWorkspaceExecutor(relay);
  const consoleRegistry = new GptActionConsole();

  app.get(`${basePath}/openapi.json`, (_request, response) => {
    response.json(createGptActionsOpenApi(config, actions));
  });
  app.get(`${basePath}/privacy`, (_request, response) => {
    response
      .type("html")
      .send(createPrivacyPolicyHtml(config.publicBaseUrl.hostname));
  });

  const router = express.Router();
  router.use(createActionLifecycleMiddleware(logger));
  router.use(createActionAuthenticationMiddleware(actions));
  router.use(createActionRateLimiter(config));
  router.use(
    express.json({
      limit: config.agent.maxPayloadBytes,
      type: ["application/json", "application/*+json"],
    }),
  );

  router.post(
    "/console/runs/start",
    createActionHandler(startConsoleRunInputSchema, logger, async (input) => {
      assertWorkspaceAllowed(actions, input.workspaceId);
      return consoleRegistry.start(input);
    }),
  );
  router.post(
    "/console/runs/update",
    createActionHandler(updateConsoleRunInputSchema, logger, async (input) =>
      consoleRegistry.update(input),
    ),
  );
  router.post(
    "/console/runs/get",
    createActionHandler(getConsoleRunInputSchema, logger, async (input) =>
      consoleRegistry.get(input.runId),
    ),
  );
  router.post(
    "/console/runs/events",
    createActionHandler(listConsoleEventsInputSchema, logger, async (input) =>
      consoleRegistry.listEvents(input.runId, input.afterSequence),
    ),
  );
  router.post(
    "/console/runs/finish",
    createActionHandler(finishConsoleRunInputSchema, logger, async (input) => {
      const result = consoleRegistry.finish(input);
      if (browser) {
        try {
          await browser.finishTask({});
        } catch (error) {
          const appError = asAppError(error);
          logger.warn({
            event: "gpt_action_browser_task_finish_failed",
            code: appError.code,
          });
        }
      }
      return result;
    }),
  );

  router.get("/workspaces", async (request: ActionRequest, response) => {
    try {
      const workspaces = await executor.listWorkspaces();
      response.json(
        workspaces.filter((workspace) =>
          actions.workspaceIds.some((workspaceId) => workspaceId === workspace.id),
        ),
      );
    } catch (error) {
      sendActionError(request, response, logger, error);
    }
  });

  router.post(
    "/files/list",
    createWorkspacePostHandler(
      listFilesActionInputSchema,
      listFilesInputSchema,
      actions,
      logger,
      (input, context) => executor.listFiles(input, context),
      trackConsole(consoleRegistry, "listarArquivosDoEspacoDeTrabalho"),
    ),
  );
  router.post(
    "/files/read",
    createWorkspacePostHandler(
      readFileActionInputSchema,
      readFileInputSchema,
      actions,
      logger,
      (input, context) => executor.readFile(input, context),
      trackConsole(consoleRegistry, "lerArquivoDoEspacoDeTrabalho"),
    ),
  );
  router.post(
    "/files/read-batch",
    createActionHandler(
      readFilesActionInputSchema,
      logger,
      async (input, context) => {
        assertWorkspaceAllowed(actions, input.workspaceId);
        return readWorkspaceFiles(executor, input, context);
      },
      trackConsole(consoleRegistry, "lerArquivosEmLoteDoEspacoDeTrabalho"),
    ),
  );
  router.post(
    "/files/search",
    createWorkspacePostHandler(
      searchFilesActionInputSchema,
      searchFilesInputSchema,
      actions,
      logger,
      (input, context) => executor.searchFiles(input, context),
      trackConsole(consoleRegistry, "buscarArquivosNoEspacoDeTrabalho"),
    ),
  );
  router.post(
    "/workspace/context",
    createWorkspacePostHandler(
      workspaceContextActionInputSchema,
      getWorkspaceContextInputSchema,
      actions,
      logger,
      (input, context) => executor.getWorkspaceContext(input, context),
      trackConsole(consoleRegistry, "obterContextoDoEspacoDeTrabalho"),
    ),
  );

  router.post(
    "/workspace/prepare",
    createActionHandler(
      prepareWorkspaceTaskInputSchema,
      logger,
      async (input, context) => {
        assertWorkspaceAllowed(actions, input.workspaceId);
        return prepareWorkspaceTask(executor, input, context);
      },
      trackConsole(consoleRegistry, "prepararTarefaNoEspacoDeTrabalho"),
    ),
  );
  router.post(
    "/workspace/validate",
    createActionHandler(
      validateWorkspaceChangesInputSchema,
      logger,
      async (input, context) => {
        assertWorkspaceAllowed(actions, input.workspaceId);
        return validateWorkspaceChanges(executor, input, context);
      },
      trackConsole(consoleRegistry, "validarAlteracoesDoEspacoDeTrabalho"),
    ),
  );

  if (actions.allowWrite) {
    router.post(
      "/files/patch",
      createActionHandler(
        patchFileActionInputSchema,
        logger,
        async (input, context) => {
          assertWorkspaceAllowed(actions, input.workspaceId);
          return executor.patchFile(
            patchFileInputSchema.parse(withoutConsoleRunId(input)),
            context,
          );
        },
        trackConsole(consoleRegistry, "aplicarAlteracoesExatasNoArquivo"),
      ),
    );
    router.post(
      "/files/write",
      createWorkspacePostHandler(
        writeFileActionInputSchema,
        writeFileInputSchema,
        actions,
        logger,
        (input, context) => executor.writeFile(input, context),
        trackConsole(consoleRegistry, "criarOuSobrescreverArquivo"),
      ),
    );
  }

  if (actions.allowShell) {
    router.post(
      "/workspace/validation/run",
      createActionHandler(
        runWorkspaceValidationActionInputSchema,
        logger,
        async (input, context) => {
          assertWorkspaceAllowed(actions, input.workspaceId);
          return executor.runValidation(
            runWorkspaceValidationInputSchema.parse(withoutConsoleRunId(input)),
            context,
          );
        },
        trackConsole(consoleRegistry, "executarValidacaoNoEspacoDeTrabalho"),
      ),
    );
    router.post(
      "/git/diff",
      createActionHandler(
        workspaceGitInputSchema,
        logger,
        async (input, context) => {
          assertWorkspaceAllowed(actions, input.workspaceId);
          return workspaceGitResultSchema.parse(
            await executor.inspectGit(
              inspectGitInputSchema.parse(withoutConsoleRunId(input)),
              context,
            ),
          );
        },
        trackConsole(consoleRegistry, "inspecionarGitDoEspacoDeTrabalho"),
      ),
    );
    router.post(
      "/shell/run",
      createWorkspacePostHandler(
        runCommandActionInputSchema,
        runCommandInputSchema,
        actions,
        logger,
        (input, context) => executor.runCommand(input, context),
        trackConsole(consoleRegistry, "executarComandoNoEspacoDeTrabalho"),
      ),
    );
    router.post(
      "/shell/powershell",
      createWorkspacePostHandler(
        runPowerShellActionInputSchema,
        runPowerShellInputSchema,
        actions,
        logger,
        (input, context) => executor.runPowerShell(input, context),
        trackConsole(consoleRegistry, "executarPowerShellNoEspacoDeTrabalho"),
      ),
    );
  }

  app.use(`${basePath}/v1`, router);
}
