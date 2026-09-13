import { describe, expect, test } from "@jest/globals";
import {
  classifyCommandRisk,
  classifyGitPushIntent,
  protectedGitPushReason,
} from "../../../src/shell/command-risk.js";

describe("Git push policy", () => {
  test("detects actual push commands", () => {
    expect(classifyGitPushIntent("powershell", "git push origin feature/safe")).toMatchObject({
      isPush: true,
      targetsMain: false,
    });
    expect(classifyGitPushIntent("git-bash", "cd repo && git push origin main")).toMatchObject({
      isPush: true,
      targetsMain: true,
    });
    expect(classifyCommandRisk("powershell", "git push origin feature/safe")).toMatchObject({
      destructive: true,
      reasons: expect.arrayContaining(["git push requires explicit user confirmation"]),
    });
  });

  test("does not treat documentation text as a push command", () => {
    const commands = [
      'Write-Output "git push origin main"',
      'echo git push origin main',
      'perl -e \'print "Git push origin main"\'',
    ] as const;

    for (const command of commands) {
      expect(classifyGitPushIntent("powershell", command)).toEqual({
        isPush: false,
        targetsMain: false,
        usesGitC: false,
        usesMirror: false,
      });
      expect(classifyCommandRisk("powershell", command)).toEqual({
        destructive: false,
        reasons: [],
      });
    }
  });

  test("lets main reach confirmation while keeping unsafe push forms hard-blocked", () => {
    const explicitMain = classifyGitPushIntent("powershell", "git push origin HEAD:main");
    expect(protectedGitPushReason(explicitMain)).toBeUndefined();

    const implicit = classifyGitPushIntent("powershell", "git push origin");
    expect(protectedGitPushReason(implicit)).toBeUndefined();
    expect(protectedGitPushReason(implicit)).toBeUndefined();

    const gitC = classifyGitPushIntent("powershell", "git -C repo push origin feature/safe");
    expect(protectedGitPushReason(gitC)).toMatch(/use the command cwd/i);

    const mirror = classifyGitPushIntent("powershell", "git push --mirror origin");
    expect(protectedGitPushReason(mirror)).toMatch(/mirror/i);
  });
});
