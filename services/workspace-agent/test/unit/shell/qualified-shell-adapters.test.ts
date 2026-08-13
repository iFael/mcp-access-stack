import { describe, expect, it } from "@jest/globals";
import {
  CmdQualifiedShellAdapter,
  PosixQualifiedShellAdapter,
  PowerShellQualifiedShellAdapter,
  type PowerShellSyntaxProbe,
} from "../../../src/shell/qualified/shell-adapters.js";

describe("qualified shell adapters", () => {
  it("prefers argv execution for simple cmd commands", async () => {
    const result = await new CmdQualifiedShellAdapter().analyze(
      'node "script with spaces.js" --check',
    );

    expect(result).toEqual({
      shell: "cmd",
      valid: true,
      execution: {
        kind: "argv",
        executable: "node",
        argv: ["script with spaces.js", "--check"],
      },
      diagnostics: [],
      usesShellFeatures: false,
    });
  });

  it("preserves shell execution when cmd metacharacters are required", async () => {
    const adapter = new CmdQualifiedShellAdapter();
    await expect(adapter.analyze("npm test && npm run build")).resolves.toMatchObject({
      valid: true,
      execution: { kind: "script" },
      usesShellFeatures: true,
    });
    await expect(adapter.analyze('echo ok & echo "unterminated')).resolves.toMatchObject({
      valid: false,
      diagnostics: [{ code: "syntax_error" }],
    });
  });

  it("validates POSIX quoting without losing argument boundaries", async () => {
    const adapter = new PosixQualifiedShellAdapter("git-bash");

    await expect(adapter.analyze("git status --short")).resolves.toMatchObject({
      valid: true,
      execution: {
        kind: "argv",
        executable: "git",
        argv: ["status", "--short"],
      },
      usesShellFeatures: false,
    });
    await expect(adapter.analyze("printf '%s' value | cat")).resolves.toMatchObject({
      valid: true,
      execution: { kind: "script" },
      usesShellFeatures: true,
    });
    await expect(adapter.analyze("echo ok | cat 'unterminated")).resolves.toMatchObject({
      valid: false,
      diagnostics: [{ code: "syntax_error" }],
    });
    await expect(adapter.analyze("echo 'unterminated")).resolves.toMatchObject({
      valid: false,
      diagnostics: [{ code: "syntax_error" }],
    });
  });

  it("uses the PowerShell AST result to select argv or report syntax errors", async () => {
    const argvProbe: PowerShellSyntaxProbe = {
      async parse() {
        return {
          available: true,
          valid: true,
          argv: ["git", "status"],
          usesShellFeatures: false,
          errors: [],
        };
      },
    };
    const invalidProbe: PowerShellSyntaxProbe = {
      async parse() {
        return {
          available: true,
          valid: false,
          usesShellFeatures: true,
          errors: ["Missing closing token."],
        };
      },
    };

    await expect(
      new PowerShellQualifiedShellAdapter("pwsh", argvProbe).analyze(
        "git status",
        ".",
      ),
    ).resolves.toMatchObject({
      valid: true,
      execution: { kind: "argv", executable: "git", argv: ["status"] },
    });
    await expect(
      new PowerShellQualifiedShellAdapter("powershell", invalidProbe).analyze(
        "Get-ChildItem (",
        ".",
      ),
    ).resolves.toMatchObject({
      valid: false,
      diagnostics: [
        { code: "syntax_error", message: "Missing closing token." },
      ],
    });
  });

  it("retries one unavailable PowerShell parser result", async () => {
    let calls = 0;
    const probe: PowerShellSyntaxProbe = {
      async parse() {
        calls += 1;
        if (calls === 1) {
          return {
            available: false,
            valid: false,
            usesShellFeatures: true,
            errors: ["powershell parser is unavailable."],
          };
        }
        return {
          available: true,
          valid: true,
          usesShellFeatures: true,
          errors: [],
        };
      },
    };

    await expect(
      new PowerShellQualifiedShellAdapter("powershell", probe).analyze(
        "$value = 'ok'; Write-Output $value",
        ".",
      ),
    ).resolves.toMatchObject({
      valid: true,
      execution: {
        kind: "script",
        script: "$value = 'ok'; Write-Output $value",
      },
      usesShellFeatures: true,
    });
    expect(calls).toBe(2);
  });
});
