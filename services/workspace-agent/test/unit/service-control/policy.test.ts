import { readFile } from "node:fs/promises";
import path from "node:path";
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
