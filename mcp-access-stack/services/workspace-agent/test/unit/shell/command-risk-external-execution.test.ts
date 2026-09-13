import { describe, expect, test } from "@jest/globals";
import { classifyCommandRisk } from "../../../src/shell/command-risk.js";

const SAFE = { destructive: false, reasons: [] } as const;

describe("external package and deploy command risk", () => {
  test.each([
    "npx --version",
    "npm exec --version",
    "pnpm dlx --help",
    "yarn dlx --help",
    "bunx --help",
    "vercel --version",
    "wrangler --version",
    "netlify --version",
    "firebase --version",
    "fly version",
    "railway --version",
    "supabase --version",
  ])("keeps runner/CLI introspection read-only: %s", (command) => {
    expect(classifyCommandRisk("powershell", command)).toEqual(SAFE);
  });

  test.each([
    "npx vercel --version",
    "npm exec vercel -- --version",
    "pnpm dlx vercel --version",
    "pnpx vercel --version",
    "yarn dlx vercel --version",
    "bunx vercel --version",
  ])("requires confirmation when a package runner targets a package: %s", (command) => {
    expect(classifyCommandRisk("powershell", command)).toMatchObject({
      destructive: true,
      reasons: expect.arrayContaining(["external package execution"]),
    });
  });

  test.each([
    "vercel --prod",
    "vercel deploy --prod",
    "wrangler deploy",
    "netlify deploy --prod",
    "firebase deploy",
    "fly deploy",
    "railway up",
    "supabase functions deploy example",
  ])("requires confirmation for external deployment mutations: %s", (command) => {
    expect(classifyCommandRisk("powershell", command)).toMatchObject({
      destructive: true,
      reasons: expect.arrayContaining(["external deployment operation"]),
    });
  });

  test.each(["pwsh", "cmd", "wsl", "git-bash"] as const)(
    "applies external execution policy consistently in %s",
    (shell) => {
      expect(classifyCommandRisk(shell, "npx vercel --version")).toMatchObject({
        destructive: true,
        reasons: expect.arrayContaining(["external package execution"]),
      });
      expect(classifyCommandRisk(shell, "wrangler deploy")).toMatchObject({
        destructive: true,
        reasons: expect.arrayContaining(["external deployment operation"]),
      });
      expect(classifyCommandRisk(shell, "vercel --version")).toEqual(SAFE);
    },
  );

  test.each([
    ["powershell", 'Write-Output "npx vercel --prod"'],
    ["cmd", 'echo "npx vercel --prod"'],
    ["git-bash", 'echo "wrangler deploy"'],
  ] as const)("keeps inert external-command text read-only: %s / %s", (shell, command) => {
    expect(classifyCommandRisk(shell, command)).toEqual(SAFE);
  });

  test.each([
    ["powershell", "Write-Output ok; npx vercel --version"],
    ["cmd", "echo ok && npx vercel --version"],
    ["git-bash", "printf ok && wrangler deploy"],
  ] as const)("does not allow shell composition to bypass external execution policy: %s / %s", (shell, command) => {
    expect(classifyCommandRisk(shell, command).destructive).toBe(true);
  });

  test.each([
    "git status 2>$null",
    "git status 2>NUL",
    "git status 2>/dev/null",
  ])("does not treat null-device stderr redirection as a file write: %s", (command) => {
    expect(classifyCommandRisk("powershell", command)).toEqual(SAFE);
  });

  test.each([
    "git status > status.txt",
    "git status 2> errors.txt",
    "git status >> status.log",
  ])("keeps real file redirection protected: %s", (command) => {
    expect(classifyCommandRisk("powershell", command)).toMatchObject({
      destructive: true,
      reasons: expect.arrayContaining(["move, overwrite or direct file write operation"]),
    });
  });

  test("aggregates unique reasons only once", () => {
    const risk = classifyCommandRisk("powershell", "npx vercel --prod");
    expect(risk.destructive).toBe(true);
    expect(new Set(risk.reasons).size).toBe(risk.reasons.length);
    expect(risk.reasons).toEqual(expect.arrayContaining([
      "external package execution",
      "external deployment operation",
    ]));
  });
});
