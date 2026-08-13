import type { ShellName } from "@vs-code-gpt/shared";

export interface CommandRisk {
  destructive: boolean;
  reasons: string[];
}

export interface GitPushIntent {
  isPush: boolean;
  targetsMain: boolean;
  usesGitC: boolean;
}

interface RiskPattern {
  reason: string;
  pattern: RegExp;
}

const RISK_PATTERNS: RiskPattern[] = [
  {
    reason: "delete, remove or force-clean operation",
    pattern: /\b(remove-item|ri|rm|del|erase|rd|rmdir|unlink|shred)\b/i,
  },
  {
    reason: "move, overwrite or direct file write operation",
    pattern:
      /\b(move-item|mi|move|mv|set-content|sc|out-file|new-item|ni|copy-item|copy|cp|cpi|tee|truncate)\b/i,
  },
  {
    reason: "registry modification or system configuration",
    pattern:
      /\b(reg|regedit|set-itemproperty|sp|new-itemproperty|remove-itemproperty|rp)\b|\bhklm:|\bhkcu:/i,
  },
  {
    reason: "disk, boot or volume operation",
    pattern: /\bformat-volume\b|\bformat(?:\.com|\.exe)?(?=\s|$)|\b(diskpart|bcdedit|mountvol|manage-bde|chkdsk\s+.*\/f|dd\s+if=)\b/i,
  },
  {
    reason: "service or process control",
    pattern:
      /\b(stop-service|spsv|restart-service|rsv|set-service|stop-process|spps|kill|taskkill|sc(?:\.exe)?\s+(delete|stop|config)|net\s+(stop|start))\b/i,
  },
  {
    reason: "destructive git operation",
    pattern:
      /\bgit(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\b(reset|clean|checkout|restore|switch|rebase)\b)/i,
  },
  {
    reason: "git push requires explicit user confirmation",
    pattern:
      /(?:^|(?:&&|\|\||[;|])\s*)(?:&\s*)?git(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\bpush\b)/i,
  },
  {
    reason: "docker cleanup or volume-removing operation",
    pattern:
      /\bdocker(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\b(system\s+prune|volume\s+prune|image\s+prune|container\s+prune|rm|rmi|compose\s+down\b[^;&|\r\n]*\s-v)\b)/i,
  },
  {
    reason: "publish, install or migration operation",
    pattern:
      /\b(npm|pnpm|yarn)\b(?=[^;&|\r\n]{0,200}\b(install|i|add|remove|publish|audit\s+fix)\b)|\b(pip|pipx)\b(?=[^;&|\r\n]{0,160}\binstall\b)|\b(prisma|sequelize|typeorm)\b(?=[^;&|\r\n]{0,160}\bmigrate\b)|\bdotnet\b(?=[^;&|\r\n]{0,200}\bef\s+database\s+update\b)/i,
  },
  {
    reason: "remote download execution or encoded command",
    pattern:
      /\b(invoke-expression|iex|encodedcommand)\b|\b(curl|wget|invoke-webrequest|iwr)\b.*(\||;).*\b(sh|bash|powershell|pwsh|cmd)\b/i,
  },
  {
    reason: "permission or ownership change",
    pattern: /\b(chmod|chown|icacls|takeown|set-acl)\b/i,
  },
  {
    reason: "dynamic PowerShell call operator",
    pattern: /(?:^|[;|]\s*)&\s*(?:\$|['"]|\.?[\\/]|[a-z_])/i,
  },
];

const FILE_REDIRECTION_PATTERN = /(?:^|\s)(?:\d?>{1,2})\s*(?!&\d)(?=\S)/i;
const GIT_PUSH_SEGMENT_PATTERN =
  /(?:^|(?:&&|\|\||[;|])\s*)(?:&\s*)?git(?:\.exe)?\b[^;&|\r\n]{0,1000}?\bpush\b[^;&|\r\n]*/i;
const MAIN_REF_PATTERN = /(?:^|[\s:+])(?:refs\/heads\/)?main(?=$|[\s:])/i;

export function classifyCommandRisk(shell: ShellName, command: string): CommandRisk {
  const normalized = normalizeForRisk(shell, command);
  const reasons = RISK_PATTERNS
    .filter((entry) => entry.pattern.test(normalized))
    .map((entry) => entry.reason);

  if (FILE_REDIRECTION_PATTERN.test(normalized)) {
    reasons.push("move, overwrite or direct file write operation");
  }

  return {
    destructive: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

export function classifyGitPushIntent(shell: ShellName, command: string): GitPushIntent {
  const normalized = normalizeForRisk(shell, command);
  const match = normalized.match(GIT_PUSH_SEGMENT_PATTERN);
  if (!match) {
    return { isPush: false, targetsMain: false, usesGitC: false };
  }

  const segment = match[0];
  const pushIndex = segment.search(/\bpush\b/i);
  const beforePush = segment.slice(0, pushIndex);
  const pushArgs = segment.slice(pushIndex + "push".length);

  return {
    isPush: true,
    targetsMain:
      /(?:^|\s)--(?:all|mirror)(?=$|\s)/i.test(pushArgs) ||
      MAIN_REF_PATTERN.test(pushArgs),
    usesGitC: /(?:^|\s)-C(?:=|\s)/.test(beforePush),
  };
}

export function protectedGitPushReason(
  intent: GitPushIntent,
  currentBranch: string | undefined,
): string | undefined {
  if (!intent.isPush) return undefined;
  if (intent.usesGitC) {
    return "git push with -C is blocked; use the command cwd so protected-branch policy can be enforced.";
  }
  if (intent.targetsMain || currentBranch?.toLocaleLowerCase("en-US") === "main") {
    return "Pushing to or from the main branch is permanently blocked.";
  }
  return undefined;
}

function normalizeForRisk(shell: ShellName, command: string): string {
  const normalized = command.replace(/`[\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (shell === "cmd") {
    return normalized.replace(/\^/g, "");
  }
  return normalized;
}
