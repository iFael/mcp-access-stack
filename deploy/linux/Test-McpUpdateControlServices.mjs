import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/update-control-deploy.yml", "utf8").replace(/\r\n/gu, "\n");
const workflowTriggers = workflow.split("\njobs:\n", 1)[0] ?? "";
const validateJob = workflow.split("  validate:\n", 2)[1]?.split("\n  deploy:\n", 1)[0] ?? "";
const deployJob = workflow.split("  deploy:\n", 2)[1] ?? "";
assert.ok(workflowTriggers.includes("pull_request:"), "PR validation must remain available");
assert.ok(workflowTriggers.includes(".github/workflows/update-control-deploy.yml"), "PR validation must cover workflow edits");
assert.ok(workflowTriggers.includes("deploy/linux/mcp-v3-oracle-read-api.service"), "PR validation must cover Oracle unit edits");
assert.ok(workflowTriggers.includes("deploy/linux/mcp-v3-update-control-oracle-channel.service"), "PR validation must cover the outbound connector unit");
assert.ok(workflowTriggers.includes("workflow_dispatch:"), "production deploy must require manual dispatch");
assert.ok(workflowTriggers.includes("DEPLOY_UPDATE_CONTROL"), "manual deploy must require explicit confirmation");
assert.ok(!workflowTriggers.includes("cloudflared"), "Update Control deploy must not depend on Cloudflare Tunnel");
assert.ok(!workflowTriggers.includes("  push:"), "merge/push must not deploy Update Control automatically");
assert.ok(deployJob.includes("github.event_name == 'workflow_dispatch'"), "deploy must run only from manual dispatch");
assert.ok(deployJob.includes("github.ref == 'refs/heads/main'"), "deploy must run only from main");
assert.ok(deployJob.includes("inputs.confirm_deploy == 'DEPLOY_UPDATE_CONTROL'"), "deploy must require the explicit confirmation input");
assert.ok(deployJob.includes("name: update-control-production"), "deploy must use the protected Environment");
assert.ok(!/secrets\.|vars\./u.test(validateJob), "PR validation must not read GitHub secrets or variables");
assert.ok(!/environment:/u.test(validateJob), "PR validation must not enter a protected Environment");
assert.ok(deployJob.includes("secrets.UPDATE_CONTROL_CF_API_TOKEN"));
assert.ok(deployJob.includes("secrets.UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN"));
assert.ok(deployJob.includes("vars.CLOUDFLARE_ACCOUNT_ID"));
assert.ok(deployJob.includes("npm exec --offline --workspace @mcp-access-stack/update-control-worker -- wrangler deploy"));
assert.ok(!/ORACLE_ACCESS_CLIENT|ORCHESTRATOR_READ_API_URL|UPDATE_CONTROL_OAUTH_REPROVISION_(?:URL|ACCESS_ISSUER|ACCESS_AUDIENCE)|cloudflared|tunnel/iu.test(deployJob), "deploy must not require the retired Access/Tunnel topology");
assert.ok(!/\bnpx\s+wrangler|npm\s+install\s+-g\s+wrangler/u.test(workflow));
assert.ok(!/public-release|edge-breakglass\.yml|release\.yml/u.test(workflow));

const apiUnit = readFileSync("deploy/linux/mcp-v3-oracle-read-api.service", "utf8");
const channelUnit = readFileSync("deploy/linux/mcp-v3-update-control-oracle-channel.service", "utf8");
assert.ok(apiUnit.includes("ORCHESTRATOR_READ_API_HOST=127.0.0.1"));
assert.ok(apiUnit.includes("ORCHESTRATOR_READ_API_PORT=9381"));
assert.ok(apiUnit.includes("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE=%d/update-control-orchestrator-token"));
assert.ok(apiUnit.includes("LoadCredential=update-control-orchestrator-token:"));
assert.ok(apiUnit.includes("StateDirectoryMode=0700"));
assert.ok(apiUnit.includes("/var/lib/mcp-access-stack-update-control/"));
assert.ok(apiUnit.includes("/opt/mcp-access-stack/update-control/current/"));
assert.ok(!/ExecStart=.*--token(?:=|\s)/u.test(apiUnit), "raw API credentials must never appear in arguments");
assert.ok(!/0\.0\.0\.0|\[::\]/u.test(apiUnit), "Oracle API must not bind all interfaces");
assert.ok(channelUnit.includes("After=network-online.target mcp-v3-oracle-read-api.service"));
assert.ok(channelUnit.includes("EnvironmentFile=/etc/mcp-access-stack/update-control/oracle-channel.env"));
assert.ok(channelUnit.includes("UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE=%d/update-control-oracle-channel-token"));
assert.ok(channelUnit.includes("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE=%d/update-control-orchestrator-token"));
assert.ok(channelUnit.includes("LoadCredential=update-control-oracle-channel-token:"));
assert.ok(channelUnit.includes("LoadCredential=update-control-orchestrator-token:"));
assert.ok(channelUnit.includes("Restart=on-failure"));
assert.ok(channelUnit.includes("StartLimitBurst=5"));
assert.ok(channelUnit.includes("DynamicUser=yes"));
assert.ok(!channelUnit.includes("StateDirectory=") && !channelUnit.includes("ReadWritePaths=") && !channelUnit.includes("orchestrator.sqlite") && !channelUnit.includes("cloudflared"), "connector must not persist business state or depend on Tunnel");
assert.ok(!channelUnit.includes("0.0.0.0") && !channelUnit.includes("[::]") && !channelUnit.includes("ListenStream="), "connector must not expose an inbound listener");
assert.ok(!/ExecStart=.*--(?:token|secret)(?:=|\s)/u.test(channelUnit), "secrets must not appear in process arguments");

for (const path of [
  ".github/workflows/update-control-deploy.yml",
  "deploy/linux/mcp-v3-oracle-read-api.service",
  "deploy/linux/mcp-v3-update-control-oracle-channel.service",
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
