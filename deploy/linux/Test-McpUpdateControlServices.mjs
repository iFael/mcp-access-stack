import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/update-control-deploy.yml", "utf8");
const workflowPull = workflow.split("  push:\n", 1)[0] ?? "";
const workflowPush = workflow.split("  push:\n", 2)[1]?.split("\njobs:\n", 1)[0] ?? "";
const validateJob = workflow.split("  validate:\n", 2)[1]?.split("\n  deploy:\n", 1)[0] ?? "";
const deployJob = workflow.split("  deploy:\n", 2)[1] ?? "";
assert.ok(workflowPull.includes(".github/workflows/update-control-deploy.yml"), "PR validation must cover workflow edits");
assert.ok(workflowPull.includes("deploy/linux/mcp-v3-oracle-read-api.service"), "PR validation must cover Oracle unit edits");
assert.ok(workflowPush.includes("services/update-control-worker/**"), "main deploy must follow Worker changes");
assert.ok(!workflowPush.includes(".github/workflows/update-control-deploy.yml"), "workflow-only merge must not deploy");
assert.match(workflow, /if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/u);
assert.match(deployJob, /environment:\n\s+name: update-control-production/u);
assert.ok(!/secrets\.|vars\./u.test(validateJob), "PR validation must not read GitHub secrets or variables");
assert.ok(!/environment:/u.test(validateJob), "PR validation must not enter a protected Environment");
assert.ok(deployJob.includes("secrets.UPDATE_CONTROL_CF_API_TOKEN"));
assert.ok(deployJob.includes("vars.CLOUDFLARE_ACCOUNT_ID"));
assert.ok(deployJob.includes("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler deploy"));
assert.ok(!/\bnpx\s+wrangler|npm\s+install\s+-g\s+wrangler/u.test(workflow));
assert.ok(!/public-release|edge-breakglass\.yml|release\.yml/u.test(workflow));

const apiUnit = readFileSync("deploy/linux/mcp-v3-oracle-read-api.service", "utf8");
const tunnelUnit = readFileSync("deploy/linux/mcp-v3-update-control-cloudflared.service", "utf8");
assert.ok(apiUnit.includes("ORCHESTRATOR_READ_API_HOST=127.0.0.1"));
assert.ok(apiUnit.includes("ORCHESTRATOR_READ_API_PORT=9381"));
assert.ok(apiUnit.includes("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE=%d/update-control-orchestrator-token"));
assert.ok(apiUnit.includes("LoadCredential=update-control-orchestrator-token:"));
assert.ok(apiUnit.includes("StateDirectoryMode=0700"));
assert.ok(apiUnit.includes("/var/lib/mcp-access-stack-update-control/"));
assert.ok(apiUnit.includes("/opt/mcp-access-stack/update-control/current/"));
assert.ok(tunnelUnit.includes("LoadCredential=cloudflared-tunnel-token:"));
assert.ok(tunnelUnit.includes("--token-file=%d/cloudflared-tunnel-token"));
assert.ok(tunnelUnit.includes("DynamicUser=yes"));
assert.ok(!/ExecStart=.*--token(?:=|\s)/u.test(apiUnit + tunnelUnit), "raw tunnel tokens must never appear in arguments");
assert.ok(!/0\.0\.0\.0|\[::\]/u.test(apiUnit), "Oracle API must not bind all interfaces");

for (const path of [
  ".github/workflows/update-control-deploy.yml",
  "deploy/linux/mcp-v3-oracle-read-api.service",
  "deploy/linux/mcp-v3-update-control-cloudflared.service",
  "docs/update-control-deployment.md",
  "deploy/linux/Test-McpUpdateControlServices.mjs",
  "services/oracle-release-orchestrator/test/unit/read-api-credential-file.test.ts",
]) {
  const contents = readFileSync(path, "utf8");
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    assert.ok(!/[ \t]+$/u.test(line), `${path}:${index + 1} has trailing whitespace`);
  }
}
console.log("Update Control deployment contracts passed.");
