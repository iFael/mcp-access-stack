import { createHash } from "node:crypto";
import {
  abortSignalError,
  commandPlanSchema,
  type CommandExpectedOutcome,
  type CommandPlan,
  type CommandPlanExecution,
  type ShellName,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../internal-types.js";
import { PathSecurity } from "../../path-security.js";
import {
  resolveDeterministicRecipe,
  type DeterministicRecipeResolution,
} from "./deterministic-recipes.js";
import {
  LimitedCommandContextCollector,
  type CommandContextCollector,
} from "./limited-context-collector.js";
import { classifyExplicitCommandExecution } from "./package-script-classifier.js";
import {
  applyPlannerProposal,
  plannerProviderInput,
  type PlannerProvider,
} from "./command-provider.js";
import {
  createRecipeCacheLookupInput,
  SanitizedRecipeCache,
  type SanitizedRecipeCacheLookupInput,
} from "./sanitized-recipe-cache.js";
import { QualifiedShellAdapterRegistry } from "./shell-adapters.js";
import type {
  CommandClassification,
  CommandQualificationIssue,
  CommandQualificationResult,
  DeterministicCommandRecipe,
  LimitedCommandContext,
  QualifiedCommandQualificationRequest,
} from "./types.js";

const SHELL_PREFERENCE: ShellName[] = [
  "pwsh",
  "powershell",
  "cmd",
  "git-bash",
  "wsl",
];

interface QualifiedCandidate {
  source: CommandPlan["source"];
  execution: CommandPlanExecution;
  classification: CommandClassification;
  recipe?: DeterministicCommandRecipe;
  cached?: boolean;
}

export class QualifiedCommandPlanQualifier {
  constructor(
    private readonly collector: CommandContextCollector =
      new LimitedCommandContextCollector(),
    private readonly adapters = new QualifiedShellAdapterRegistry(),
    private readonly recipeCache = new SanitizedRecipeCache(),
    private readonly plannerProvider?: PlannerProvider,
  ) {}

  recipeCacheSnapshot() {
    return this.recipeCache.snapshot();
  }

  async qualify(
    workspace: ResolvedWorkspace,
    request: QualifiedCommandQualificationRequest,
  ): Promise<CommandQualificationResult> {
    const context = await this.collector.collect(workspace, request.input);
    if (
      request.workspaceId !== workspace.id ||
      request.input.workspaceId !== workspace.id
    ) {
      return blocked(context, [
        {
          code: "WORKSPACE_MISMATCH",
          message: "Qualified command workspace binding does not match the resolved workspace.",
        },
      ]);
    }

    let cacheInput: SanitizedRecipeCacheLookupInput | undefined;
    let shouldStoreRecipe = false;
    let candidate: QualifiedCandidate | { issues: CommandQualificationIssue[] };
    let shellSelection:
      | { shell: ShellName }
      | { issue: CommandQualificationIssue };
    if (request.input.command) {
      shellSelection = selectShell(context, request.input);
      if ("issue" in shellSelection) {
        return blocked(context, [shellSelection.issue]);
      }
      candidate = await this.fromExplicitCommand(
        request.input.command,
        shellSelection.shell,
        context,
      );
    } else {
      cacheInput = createRecipeCacheLookupInput(request.input, context);
      const cached = cacheInput
        ? this.recipeCache.lookup(cacheInput)
        : { status: "miss" as const };
      if (cached.status === "hit") {
        candidate = candidateFromCachedRecipe(cached.recipe);
      } else {
        candidate = this.fromObjective(request.input.objective ?? "", context);
        shouldStoreRecipe = true;
      }
      if ("issues" in candidate) {
        const providerResult = await this.qualifyWithProvider(
          workspace,
          request,
          context,
          candidate.issues,
        );
        if (providerResult) return providerResult;
        return blocked(context, candidate.issues);
      }
      shellSelection = selectShell(
        context,
        request.input,
        candidate.recipe?.shell,
      );
      if ("issue" in shellSelection) {
        return blocked(context, [shellSelection.issue]);
      }
    }

    if ("issues" in candidate) return blocked(context, candidate.issues);
    const shell = shellSelection.shell;
    if (candidate.cached) {
      candidate = {
        ...candidate,
        classification: classifyExplicitCommandExecution(
          shell,
          candidate.execution,
          context,
        ),
      };
    }
    const prerequisiteIssues = validateRecipePrerequisites(
      candidate.recipe,
      context,
    );
    if (prerequisiteIssues.length > 0) {
      return blocked(context, prerequisiteIssues);
    }
    if (
      candidate.classification.effectClass === "unknown" ||
      candidate.classification.riskClass === "unknown"
    ) {
      return blocked(context, [
        {
          code: "UNQUALIFIABLE_EFFECT",
          message: "Command effect or risk could not be classified deterministically.",
        },
      ]);
    }

    const expectedOutcomes = expectedOutcomesFor(
      request.input.expectedOutcome,
      candidate.recipe,
    );
    const postconditionIssues = validatePostconditions(
      workspace,
      context.logicalCwd,
      expectedOutcomes,
    );
    if (postconditionIssues.length > 0) {
      return blocked(context, postconditionIssues);
    }

    const now = request.now ?? new Date();
    const unsignedPlan = {
      invocationId: request.invocationId,
      ...(request.input.objective === undefined
        ? {}
        : { objective: request.input.objective }),
      source: candidate.source,
      shell,
      cwd: context.logicalCwd,
      execution: candidate.execution,
      timeoutMs: request.input.timeoutMs,
      absoluteDeadline:
        request.absoluteDeadline ??
        new Date(now.getTime() + request.input.timeoutMs).toISOString(),
      riskClass: candidate.classification.riskClass,
      effectClass: candidate.classification.effectClass,
      expectedOutcomes,
      postconditions: expectedOutcomes,
      provenance: {
        source: candidate.source,
        ...(candidate.recipe ? { recipeId: candidate.recipe.id } : {}),
        sanitized: true,
      },
    } satisfies Omit<CommandPlan, "fingerprint">;
    const plan = commandPlanSchema.parse({
      ...unsignedPlan,
      fingerprint: fingerprint(fingerprintSource(unsignedPlan)),
    });
    if (shouldStoreRecipe && cacheInput && candidate.recipe) {
      this.recipeCache.store(cacheInput, candidate.recipe);
    }

    return {
      status: "qualified",
      plan,
      context,
      ...(candidate.recipe ? { recipeId: candidate.recipe.id } : {}),
    };
  }

  private async qualifyWithProvider(
    workspace: ResolvedWorkspace,
    request: QualifiedCommandQualificationRequest,
    context: LimitedCommandContext,
    issues: CommandQualificationIssue[],
  ): Promise<CommandQualificationResult | undefined> {
    if (
      !this.plannerProvider ||
      issues.length !== 1 ||
      issues[0]?.code !== "NO_DETERMINISTIC_RECIPE"
    ) {
      return undefined;
    }
    const providerInput = plannerProviderInput(request.input, context);
    if (!providerInput) return undefined;
    try {
      const proposal = await this.plannerProvider.plan(
        providerInput,
        request.signal,
      );
      if (proposal.status !== "proposal") return undefined;
      const proposedInput = applyPlannerProposal(request.input, proposal);
      const qualified = await this.qualify(workspace, {
        ...request,
        input: proposedInput,
      });
      if (qualified.status !== "qualified") return qualified;
      if (
        qualified.plan.riskClass !== "safe" ||
        (qualified.plan.effectClass !== "pure_read" &&
          qualified.plan.effectClass !== "repeatable_local")
      ) {
        return blocked(qualified.context, [
          {
            code: "UNQUALIFIABLE_EFFECT",
            message:
              "Provider-generated plans must remain safe and locally repeatable.",
          },
        ]);
      }
      const { fingerprint: _fingerprint, ...basePlan } = qualified.plan;
      const unsignedPlan = {
        ...basePlan,
        source: "provider" as const,
        provenance: {
          source: "provider" as const,
          provider: this.plannerProvider.identity.name,
          model: this.plannerProvider.identity.model,
          sanitized: true,
        },
      };
      return {
        status: "qualified",
        plan: commandPlanSchema.parse({
          ...unsignedPlan,
          fingerprint: fingerprint(fingerprintSource(unsignedPlan)),
        }),
        context: qualified.context,
      };
    } catch {
      if (request.signal?.aborted) throw abortSignalError(request.signal);
      return undefined;
    }
  }

  private async fromExplicitCommand(
    command: string,
    shell: ShellName,
    context: LimitedCommandContext,
  ): Promise<QualifiedCandidate | { issues: CommandQualificationIssue[] }> {
    const analysis = await this.adapters.analyze(
      shell,
      command,
      context.absoluteCwd,
    );
    if (!analysis.valid || !analysis.execution) {
      return {
        issues: [
          {
            code: "INVALID_COMMAND_SYNTAX",
            message:
              analysis.diagnostics[0]?.message ??
              "Command syntax could not be qualified.",
          },
        ],
      };
    }
    return {
      source: "explicit-command",
      execution: analysis.execution,
      classification: classifyExplicitCommandExecution(
        shell,
        analysis.execution,
        context,
      ),
    };
  }

  private fromObjective(
    objective: string,
    context: LimitedCommandContext,
  ): QualifiedCandidate | { issues: CommandQualificationIssue[] } {
    const resolution = resolveDeterministicRecipe(objective, context);
    if (resolution.status === "not_found") {
      return {
        issues: [
          {
            code: "NO_DETERMINISTIC_RECIPE",
            message: "No deterministic command recipe matches the objective.",
          },
        ],
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        issues: [
          {
            code: "AMBIGUOUS_DETERMINISTIC_RECIPE",
            message: `Objective matches multiple deterministic recipes: ${resolution.recipeIds.join(
              ", ",
            )}.`,
          },
        ],
      };
    }
    return candidateFromRecipe(resolution);
  }
}

function candidateFromRecipe(
  resolution: Extract<DeterministicRecipeResolution, { status: "resolved" }>,
): QualifiedCandidate {
  return {
    source: "deterministic-recipe",
    execution: resolution.recipe.execution,
    classification: resolution.recipe.classification,
    recipe: resolution.recipe,
  };
}

function candidateFromCachedRecipe(
  recipe: DeterministicCommandRecipe,
): QualifiedCandidate {
  return {
    source: "deterministic-recipe",
    execution: recipe.execution,
    classification: recipe.classification,
    recipe,
    cached: true,
  };
}

function selectShell(
  context: LimitedCommandContext,
  input: QualifiedCommandQualificationRequest["input"],
  recipeShell: ShellName | "auto" | undefined = "auto",
): { shell: ShellName } | { issue: CommandQualificationIssue } {
  const preferred = input.preferredShell;
  const requested = input.shell ?? (preferred === "auto" ? undefined : preferred);
  if (
    input.shell &&
    preferred &&
    preferred !== "auto" &&
    preferred !== input.shell
  ) {
    return {
      issue: {
        code: "SHELL_CONFLICT",
        message: "shell and preferredShell select different shells.",
      },
    };
  }
  if (recipeShell !== "auto" && requested && requested !== recipeShell) {
    return {
      issue: {
        code: "SHELL_CONFLICT",
        message: `Deterministic recipe requires the ${recipeShell} shell.`,
      },
    };
  }

  const explicit = recipeShell === "auto" ? requested : recipeShell;
  if (explicit) {
    if (!context.allowedShells.includes(explicit)) {
      return {
        issue: {
          code: "SHELL_NOT_ALLOWED",
          message: `Workspace policy does not allow the ${explicit} shell.`,
        },
      };
    }
    if (!toolAvailable(context, explicit)) {
      return {
        issue: {
          code: "REQUIRED_TOOL_UNAVAILABLE",
          message: `The selected ${explicit} shell is unavailable.`,
        },
      };
    }
    return { shell: explicit };
  }

  const shell = SHELL_PREFERENCE.find(
    (candidate) =>
      context.allowedShells.includes(candidate) && toolAvailable(context, candidate),
  );
  if (!shell) {
    return {
      issue: {
        code: "NO_ALLOWED_SHELL",
        message: "No allowed and available shell can qualify the command.",
      },
    };
  }
  return { shell };
}

function validateRecipePrerequisites(
  recipe: DeterministicCommandRecipe | undefined,
  context: LimitedCommandContext,
): CommandQualificationIssue[] {
  if (!recipe) return [];
  const issues: CommandQualificationIssue[] = [];
  for (const tool of recipe.requiredTools) {
    if (!toolAvailable(context, tool)) {
      issues.push({
        code: "REQUIRED_TOOL_UNAVAILABLE",
        message: `Deterministic recipe requires unavailable tool: ${tool}.`,
      });
    }
  }
  const markerPaths = new Set(context.markers.map((marker) => marker.path));
  for (const marker of recipe.requiredMarkers) {
    if (!markerPaths.has(marker)) {
      issues.push({
        code: "REQUIRED_MARKER_MISSING",
        message: `Deterministic recipe requires missing marker: ${marker}.`,
      });
    }
  }
  return issues;
}

function validatePostconditions(
  workspace: ResolvedWorkspace,
  logicalCwd: string,
  outcomes: CommandExpectedOutcome[],
): CommandQualificationIssue[] {
  const security = new PathSecurity(workspace);
  const issues: CommandQualificationIssue[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "http_status" || outcome.kind === "process_exited") {
      issues.push({
        code: "INVALID_POSTCONDITION",
        message:
          "This postcondition requires an authority binding that is not available in qualified planning yet.",
      });
      continue;
    }

    let target: string | undefined;
    let allowDot = false;
    switch (outcome.kind) {
      case "file_exists":
      case "file_absent":
      case "sha256":
      case "json_field":
        target = outcome.path;
        break;
      case "git_clean":
        target = outcome.root;
        allowDot = true;
        break;
      default:
        continue;
    }

    try {
      security.authorizeLogical(resolveFromCwd(logicalCwd, target), allowDot);
    } catch {
      issues.push({
        code: "INVALID_POSTCONDITION",
        message: "Postcondition path is outside the authorized workspace scope.",
      });
    }
  }
  return issues;
}

function resolveFromCwd(logicalCwd: string, target: string): string {
  if (logicalCwd === ".") return target;
  if (target === ".") return logicalCwd;
  return `${logicalCwd}/${target}`;
}

function toolAvailable(context: LimitedCommandContext, tool: string): boolean {
  return context.tools.some((entry) => entry.name === tool && entry.available);
}

function expectedOutcomesFor(
  configured: CommandExpectedOutcome[] | undefined,
  recipe: DeterministicCommandRecipe | undefined,
): CommandExpectedOutcome[] {
  if (configured && configured.length > 0) return configured;
  return [
    {
      kind: "exit_code",
      value: recipe?.defaultPostconditionExitCode ?? 0,
    },
  ];
}

function blocked(
  context: LimitedCommandContext,
  issues: CommandQualificationIssue[],
): CommandQualificationResult {
  return { status: "blocked", issues, context };
}

function fingerprintSource(
  plan: Omit<CommandPlan, "fingerprint">,
): Omit<CommandPlan, "fingerprint" | "invocationId" | "absoluteDeadline"> {
  return {
    ...(plan.objective === undefined ? {} : { objective: plan.objective }),
    source: plan.source,
    shell: plan.shell,
    cwd: plan.cwd,
    execution: plan.execution,
    timeoutMs: plan.timeoutMs,
    riskClass: plan.riskClass,
    effectClass: plan.effectClass,
    expectedOutcomes: plan.expectedOutcomes,
    postconditions: plan.postconditions,
    provenance: plan.provenance,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
