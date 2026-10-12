import { afterEach, describe, expect, it } from "@jest/globals";
import { chmod, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalAgent } from "../../../src/local-agent.js";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import { TrustedCampaignEnrollmentCatalog } from "../../../src/campaign/trusted-campaign-enrollment-catalog.js";
import { bindGitCleanInspection } from "../../../src/campaign/typed-read-capabilities.js";
import { runTrustedCampaignService } from "../../../src/campaign/trusted-campaign-service-entrypoint.js";
import { createFixture, git, initializeGitRepository, writeWorkspaceFile, type Fixture } from "../../support/helpers.js";

const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerScope = "trusted:test-service-owner";
const configFactoryId = "git-clean-v1";
let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function setup() {
  fixture = await createFixture({ profile: "full-repo-readonly" });
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath, ["checkout", "-b", "feature/service"]);
  await writeWorkspaceFile(fixture.workspacePath, "base.txt", "read only\n");
  git(fixture.workspacePath, ["add", "base.txt"]);
  git(fixture.workspacePath, ["commit", "-m", "baseline"]);
  const agent = await LocalAgent.create(fixture.policyPath);
  const bound = bindGitCleanInspection(agent, {
    workspaceId: "test", root: ".", expectedBranch: "feature/service",
  }, { ownerScope });
  const ledger = new DelegatedCampaignLedger(fixture.basePath, ownerScope);
  await ledger.create({
    campaignId, workspaceId: "test", objective: "Check the same permitted branch",
    authorizedActions: ["inspect"],
    tasks: [{ id: "read", dependsOn: [], ...bound.definition }],
  });
  const catalog = new TrustedCampaignEnrollmentCatalog(fixture.basePath);
  await catalog.enroll(agent, {
    workspaceId: "test", campaignId, factoryId: configFactoryId,
  }, new Map([[configFactoryId, {
    ownerScope,
    bind: async host => new Map([[
      "read",
      bindGitCleanInspection(host, {
        workspaceId: "test", root: ".", expectedBranch: "feature/service",
      }, { ownerScope }).capability,
    ]]),
  }]]));
  const config = {
    version: 1,
    policyPath: fixture.policyPath,
    stateDirectory: fixture.basePath,
    factories: [{
      id: configFactoryId, kind: "git-clean-inspect-v1",
      workspaceId: "test", expectedBranch: "feature/service",
      ownerScope, taskIds: ["read"],
    }],
    maxEpochs: 2, maxWakesPerEpoch: 2,
  };
  const configPath = path.join(fixture.basePath, "service-config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  const owner = (await lstat(configPath)).uid;
  return { config, configPath, owner, ledger };
}

describe("root-controlled campaign service bootstrap", () => {
  it("restores a code-defined inspect-only capability and verifies proof", async () => {
    const { configPath, owner, ledger } = await setup();
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
    const result = await runTrustedCampaignService(configPath, {
      configOwnerUid: owner,
    });
    expect(result.stop).toBe("all_completed");
    expect(result.wakes).toBeGreaterThan(0);
    const record = await ledger.get("test", campaignId);
    expect(record?.tasks[0]?.state).toBe("completed");
    expect(record?.tasks[0]?.proof?.reference).toMatch(/^git-clean:[a-f0-9]{64}$/u);
  }, 20000);

  it("does not dispatch anything with an already aborted signal", async () => {
    const { configPath, owner, ledger } = await setup();
    const controller = new AbortController();
    controller.abort();
    const report = await runTrustedCampaignService(configPath, {
      configOwnerUid: owner, signal: controller.signal,
    });
    expect(report).toEqual({
      stop: "stopped", epochs: 0, wakes: 0, campaigns: [],
    });
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
  });

  it("fails closed when trusted factory parameters no longer match the stored plan", async () => {
    const { configPath, owner, config, ledger } = await setup();
    config.factories[0]!.expectedBranch = "feature/altered";
    await writeFile(configPath, JSON.stringify(config));
    await expect(runTrustedCampaignService(configPath, {
      configOwnerUid: owner,
    })).rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
  });

  it("rejects extra fields and arbitrary executable factory kinds before starting", async () => {
    const { configPath, owner, config, ledger } = await setup();
    await writeFile(configPath, JSON.stringify({ ...config, command: "rm -rf /" }));
    await expect(runTrustedCampaignService(configPath, {
      configOwnerUid: owner,
    })).rejects.toThrow("CAMPAIGN_SERVICE_INVALID");
    const bad = JSON.parse(JSON.stringify(config));
    bad.factories[0].kind = "shell";
    await writeFile(configPath, JSON.stringify(bad));
    await expect(runTrustedCampaignService(configPath, {
      configOwnerUid: owner,
    })).rejects.toThrow("CAMPAIGN_SERVICE_INVALID");
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
  });

  it("refuses symlinked, untrusted-owner or writable-by-group config", async () => {
    const { configPath, owner, ledger } = await setup();
    const link = path.join(fixture!.basePath, "service-config-link.json");
    if (process.platform !== "win32") {
      await symlink(configPath, link);
      await expect(runTrustedCampaignService(link, {
        configOwnerUid: owner,
      })).rejects.toThrow("CAMPAIGN_SERVICE_UNTRUSTED_CONFIG");
    }
    await expect(runTrustedCampaignService(configPath, {
      configOwnerUid: owner + 1,
    })).rejects.toThrow("CAMPAIGN_SERVICE_UNTRUSTED_CONFIG");
    if (process.platform !== "win32") {
      await chmod(configPath, 0o660);
      await expect(runTrustedCampaignService(configPath, {
        configOwnerUid: owner,
      })).rejects.toThrow("CAMPAIGN_SERVICE_UNTRUSTED_CONFIG");
    }
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
  });

  it("rejects conflicting audit or task storage outside the trusted state root", async () => {
    const { configPath, owner, ledger } = await setup();
    const before = process.env.VS_CODE_GPT_DATA_DIR;
    process.env.VS_CODE_GPT_DATA_DIR = path.join(fixture!.basePath, "elsewhere");
    try {
      await expect(runTrustedCampaignService(configPath, {
        configOwnerUid: owner,
      })).rejects.toThrow("CAMPAIGN_SERVICE_UNTRUSTED_RUNTIME_STATE");
    } finally {
      if (before === undefined) delete process.env.VS_CODE_GPT_DATA_DIR;
      else process.env.VS_CODE_GPT_DATA_DIR = before;
    }
    expect((await ledger.get("test", campaignId))?.revision).toBe(0);
  });
});
