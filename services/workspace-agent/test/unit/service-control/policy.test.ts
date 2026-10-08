import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "@jest/globals";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const policyPath = path.join(
  repositoryRoot,
  "deploy/linux/mcp-v3-service-control.sudoers",
);
const installerPath = path.join(
  repositoryRoot,
  "deploy/linux/Install-McpV3ServiceControlPolicy.sh",
);
const polkitRulePath = path.join(
  repositoryRoot,
  "deploy/linux/00-mcp-v3-service-control.rules",
);
const polkitInstallerPath = path.join(
  repositoryRoot,
  "deploy/linux/Install-McpV3ServicePolkitPolicy.sh",
);

describe("managed Linux service-control privilege policy", () => {
  it("grants only the two exact allowlisted start commands", async () => {
    const policy = await readFile(policyPath, "utf8");
    const rules = policy
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(rules).toEqual([
      "mcp-access-stack ALL=(root) NOPASSWD: /usr/bin/systemctl start mcp-v3-oracle-read-api.service",
      "mcp-access-stack ALL=(root) NOPASSWD: /usr/bin/systemctl start mcp-v3-update-control-oracle-channel.service",
    ]);

    for (const forbidden of [
      "*",
      " stop ",
      " restart ",
      " reload ",
      " enable ",
      " disable ",
      "/bin/sh",
      "/bin/bash",
    ]) {
      expect(rules.join("\n")).not.toContain(forbidden);
    }
  });

  it("installs the policy root-only through visudo validation", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('[[ "$(id -u)" -eq 0 ]]');
    expect(installer).toContain('target="/etc/sudoers.d/mcp-v3-service-control"');
    expect(installer).toContain('install -o root -g root -m 0440');
    expect(installer.match(/visudo -cf/g)).toHaveLength(2);

    for (const forbidden of [
      "systemctl start",
      "systemctl stop",
      "systemctl restart",
      "systemctl enable",
      "systemctl disable",
    ]) {
      expect(installer).not.toContain(forbidden);
    }
  });
});

describe("managed Linux service-control Polkit policy", () => {
  type TestAction = {
    id: string;
    lookup: (key: string) => string | undefined;
  };
  type TestSubject = { user: string };

  it("authorizes exclusively start on the two approved units for the service identity", async () => {
    const source = await readFile(polkitRulePath, "utf8");
    let rule: ((action: TestAction, subject: TestSubject) => string | undefined) | undefined;
    const policy = {
      Result: { YES: "YES", NO: "NO" },
      addRule(callback: typeof rule) {
        if (rule) throw new Error("More than one Polkit rule is not allowed.");
        rule = callback;
      },
    };
    runInNewContext(source, { polkit: policy });
    expect(rule).toBeDefined();

    const result = (
      user: string,
      verb: string | undefined,
      unit: string | undefined,
      actionId = "org.freedesktop.systemd1.manage-units",
    ) => rule!(
      {
        id: actionId,
        lookup: (key) => key === "unit" ? unit : key === "verb" ? verb : undefined,
      },
      { user },
    );

    for (const unit of [
      "mcp-v3-oracle-read-api.service",
      "mcp-v3-update-control-oracle-channel.service",
    ]) {
      expect(result("mcp-access-stack", "start", unit)).toBe("YES");
      for (const verb of ["stop", "restart", "reload", "enable", "disable", "", undefined]) {
        expect(result("mcp-access-stack", verb, unit)).toBe("NO");
      }
      expect(result("ubuntu", "start", unit)).toBeUndefined();
      expect(result("root", "start", unit)).toBeUndefined();
    }

    for (const unit of [
      "ssh.service",
      "mcp-v3-oracle-read-api.service;reboot",
      "mcp-v3-update-control-oracle-channel.service ",
      "",
      undefined,
    ]) {
      expect(result("mcp-access-stack", "start", unit)).toBe("NO");
    }

    expect(result("mcp-access-stack", "start", "mcp-v3-oracle-read-api.service",
      "org.freedesktop.systemd1.manage-unit-files")).toBeUndefined();
  });

  it("pins the rule digest and installs atomically as root without privilege expansion", async () => {
    const source = await readFile(polkitRulePath, "utf8");
    const installer = await readFile(polkitInstallerPath, "utf8");
    const digest = createHash("sha256").update(source).digest("hex");

    expect(installer).toContain('expected_sha256="' + digest + '"');
    expect(installer).toContain('[[ "$(id -u)" -eq 0 ]]');
    expect(installer).toContain('[[ -f "$source_path" && ! -L "$source_path" ]]');
    expect(installer).toContain('target="/etc/polkit-1/rules.d/00-mcp-v3-service-control.rules"');
    expect(installer).toContain("install -o root -g root -m 0644");
    expect(installer).toContain('ln -- "$stage" "$target"');
    expect(installer).toContain('verify_file "$stage"');
    expect(installer).toContain('verify_file "$target"');
    expect(installer).not.toContain("sudoers.d");
    expect(installer).not.toContain("systemctl start");
    expect(installer).not.toContain("systemctl restart");
  });
});
