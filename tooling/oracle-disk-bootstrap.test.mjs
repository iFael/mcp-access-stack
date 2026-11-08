import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SHA = "c922695d1e2c02521619e4e472c3e4fc696f51c4f6c01f78164a564ad9fd8aa3";
const INSTALLER_SHA = "aaf90ffd346b76ae65f350bf4b40137f1feb110b84cba3bd0e296d3756787bec";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("one-time host bootstrap pins immutable installer and auditor source hashes", async () => {
  const bootstrap = await readFile(new URL("../deploy/linux/Install-McpV3DiskAuditBootstrap.sh", import.meta.url), "utf8");
  const installer = await readFile(new URL("../deploy/linux/Install-McpV3DiskAuditPolicy.sh", import.meta.url));
  const module = await readFile(new URL("./oracle-disk-audit.mjs", import.meta.url));
  assert.equal(sha256(installer), INSTALLER_SHA);
  assert.equal(sha256(module), SHA);
  assert.ok(bootstrap.includes(`module_sha="${SHA}"`));
  assert.ok(bootstrap.includes(`installer_sha="${INSTALLER_SHA}"`));
  assert.ok(bootstrap.includes('[[ "$(id -u)" == 0 ]]'));
  assert.ok(bootstrap.includes('[[ "$#" == 0 ]]'));
  assert.ok(bootstrap.includes('NOPASSWD: /usr/local/libexec/mcp-v3-root-provision-disk-audit ""'));
  assert.ok(bootstrap.includes('visudo -cf "$stage_policy"'));
  assert.ok(bootstrap.includes('install -o root -g root -m 0644 "$installer" "$stage_installer"'));
  assert.ok(!bootstrap.includes('sudo ALL='));
});

test("root provision entry point has no untrusted command or path parameters", async () => {
  const bootstrap = await readFile(new URL("../deploy/linux/Install-McpV3DiskAuditBootstrap.sh", import.meta.url), "utf8");
  assert.ok(bootstrap.includes('exec /bin/bash /usr/local/libexec/mcp-v3-root-disk-installer.sh'));
  assert.ok(bootstrap.includes('/var/lib/mcp-access-stack/current/tooling/oracle-disk-audit.mjs'));
  assert.ok(bootstrap.includes('/opt/mcp-access-stack/node-v26.10.0-linux-x64/bin/node'));
});
