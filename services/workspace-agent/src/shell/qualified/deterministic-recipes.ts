import type { CommandPlanExecution } from "@vs-code-gpt/shared";
import type {
  DeterministicCommandRecipe,
  LimitedCommandContext,
  LimitedPackageScriptMetadata,
} from "./types.js";

const PACKAGE_SCRIPT_INTENTS = new Map<
  string,
  DeterministicCommandRecipe["intent"]
>([
  ["test", "test"],
  ["test:unit", "test"],
  ["test:integration", "test"],
  ["test:e2e", "test"],
  ["build", "build"],
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["type-check", "typecheck"],
  ["check", "check"],
]);

export type DeterministicRecipeResolution =
  | { status: "resolved"; recipe: DeterministicCommandRecipe }
  | { status: "not_found" }
  | { status: "ambiguous"; recipeIds: string[] };

export function buildDeterministicRecipeCatalog(
  context: LimitedCommandContext,
): DeterministicCommandRecipe[] {
  const recipes: DeterministicCommandRecipe[] = [];
  if (context.git.repository) {
    recipes.push({
      id: "git.status",
      description: "Inspect the current Git branch and working tree status.",
      intent: "git-status",
      shell: "auto",
      execution: {
        kind: "argv",
        executable: "git",
        argv: ["status", "--short", "--branch"],
      },
      requiredTools: ["git"],
      requiredMarkers: [],
      classification: {
        effectClass: "pure_read",
        riskClass: "safe",
        reasons: ["typed Git status recipe is read-only"],
      },
      defaultPostconditionExitCode: 0,
    });
  }

  const packageMetadata = context.packageMetadata;
  if (!packageMetadata) return recipes;
  const packageManager = normalizePackageManager(packageMetadata.packageManager);
  for (const script of packageMetadata.scripts) {
    const intent = PACKAGE_SCRIPT_INTENTS.get(script.name.toLowerCase());
    if (!intent || !isSafeRecipeScript(script)) continue;
    recipes.push({
      id: `package-script.${script.name}`,
      description: `Run the package script ${script.name}.`,
      intent,
      shell: "auto",
      execution: packageScriptExecution(packageManager, script.name),
      requiredTools: [packageManager],
      requiredMarkers: ["package.json"],
      classification: {
        effectClass: script.effectClass,
        riskClass: script.riskClass,
        reasons: [
          `package script ${script.name} was classified from its manifest command hash`,
        ],
      },
      defaultPostconditionExitCode: 0,
    });
  }

  return recipes.sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveDeterministicRecipe(
  objective: string,
  context: LimitedCommandContext,
): DeterministicRecipeResolution {
  const catalog = buildDeterministicRecipeCatalog(context);
  const normalized = normalizeObjective(objective);
  const requestedIntents = detectIntents(normalized);
  if (requestedIntents.length === 0) return { status: "not_found" };

  if (requestedIntents.length === 1) {
    const explicitScriptMatches = catalog.filter((recipe) =>
      recipe.id.startsWith("package-script.")
        ? includesToken(normalized, recipe.id.slice("package-script.".length))
        : false,
    );
    if (explicitScriptMatches.length === 1) {
      return { status: "resolved", recipe: explicitScriptMatches[0]! };
    }
    if (explicitScriptMatches.length > 1) {
      return {
        status: "ambiguous",
        recipeIds: explicitScriptMatches.map((recipe) => recipe.id),
      };
    }
  }

  const matches = catalog.filter((recipe) => requestedIntents.includes(recipe.intent));
  if (matches.length === 1) return { status: "resolved", recipe: matches[0]! };
  if (matches.length === 0) return { status: "not_found" };

  if (requestedIntents.length === 1) {
    const exactIntentMatches = matches.filter((recipe) => {
      if (!recipe.id.startsWith("package-script.")) return false;
      const scriptName = recipe.id.slice("package-script.".length);
      return requestedIntents.some((intent) => scriptName === intent);
    });
    if (exactIntentMatches.length === 1) {
      return { status: "resolved", recipe: exactIntentMatches[0]! };
    }
  }

  return {
    status: "ambiguous",
    recipeIds: matches.map((recipe) => recipe.id),
  };
}

function isSafeRecipeScript(script: LimitedPackageScriptMetadata): boolean {
  return (
    script.riskClass === "safe" &&
    (script.effectClass === "pure_read" || script.effectClass === "repeatable_local")
  );
}

function normalizePackageManager(value: string | undefined): string {
  const declared = value?.split("@", 1)[0]?.toLowerCase();
  if (declared === "pnpm" || declared === "yarn" || declared === "bun") {
    return declared;
  }
  return "npm";
}

function packageScriptExecution(
  packageManager: string,
  scriptName: string,
): CommandPlanExecution {
  if (packageManager === "npm" && scriptName === "test") {
    return { kind: "argv", executable: "npm", argv: ["test"] };
  }
  return {
    kind: "argv",
    executable: packageManager,
    argv: ["run", scriptName],
  };
}

function detectIntents(
  objective: string,
): DeterministicCommandRecipe["intent"][] {
  const intents = new Set<DeterministicCommandRecipe["intent"]>();
  if (/\b(test|tests|teste|testes|unitario|unitarios|integracao|e2e)\b/u.test(objective)) {
    intents.add("test");
  }
  if (/\b(build|compilar|compilacao|empacotar)\b/u.test(objective)) {
    intents.add("build");
  }
  if (/\b(lint|eslint)\b/u.test(objective)) intents.add("lint");
  if (/\b(typecheck|type-check|tipos|typescript)\b/u.test(objective)) {
    intents.add("typecheck");
  }
  if (/\b(git status|status do git|estado do git|working tree)\b/u.test(objective)) {
    intents.add("git-status");
  }
  if (
    intents.size === 0 &&
    /\b(check|validar|validacao|verificar|verificacao)\b/u.test(objective)
  ) {
    intents.add("check");
  }
  return [...intents];
}

function normalizeObjective(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.:+-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function includesToken(value: string, token: string): boolean {
  return (` ${value} `).includes(` ${token.toLowerCase()} `);
}
