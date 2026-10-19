import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { LocalAgent } from "../local-agent.js";
import { TrustedCampaignEnrollmentCatalog, type TrustedCampaignBindingFactories } from "./trusted-campaign-enrollment-catalog.js";
import { TrustedCampaignProcessHost, type TrustedCampaignProcessReport } from "./trusted-campaign-process-host.js";
import { bindGitCleanInspection } from "./typed-read-capabilities.js";

type GitCleanFactory = {
  id: string;
  kind: "git-clean-inspect-v1";
  workspaceId: string;
  expectedBranch: string;
  ownerScope: string;
  taskIds: string[];
};
type ServiceConfig = {
  version: 1;
  policyPath: string;
  stateDirectory: string;
  factories: GitCleanFactory[];
  maxEpochs: number;
  maxWakesPerEpoch: number;
};
export interface TrustedServiceOptions {
  /** Only a code-owned test harness may override the production root UID. */
  readonly configOwnerUid?: number;
  readonly signal?: AbortSignal;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const WORKSPACE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,127}$/u;

function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CAMPAIGN_SERVICE_INVALID: " + name);
  }
  const fields = Object.keys(value).sort().join(",");
  if (fields !== [...keys].sort().join(",")) {
    throw new Error("CAMPAIGN_SERVICE_INVALID: " + name + " fields");
  }
  return value as Record<string, unknown>;
}
function absolute(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      path.normalize(value) !== value || value.includes("\0")) {
    throw new Error("CAMPAIGN_SERVICE_INVALID: " + name);
  }
  return value;
}
function budget(value: unknown, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error("CAMPAIGN_SERVICE_INVALID: " + name);
  }
  return value as number;
}
function parseConfig(value: unknown): ServiceConfig {
  const c = object(value, [
    "version", "policyPath", "stateDirectory", "factories",
    "maxEpochs", "maxWakesPerEpoch",
  ], "config");
  if (c.version !== 1 || !Array.isArray(c.factories) ||
      c.factories.length < 1 || c.factories.length > 16) {
    throw new Error("CAMPAIGN_SERVICE_INVALID: configuration version or factories");
  }
  const factories: GitCleanFactory[] = [];
  const seen = new Set<string>();
  for (const item of c.factories) {
    const f = object(item, [
      "id", "kind", "workspaceId", "expectedBranch", "ownerScope", "taskIds",
    ], "factory");
    if (f.kind !== "git-clean-inspect-v1" || typeof f.id !== "string" ||
        !ID.test(f.id) || seen.has(f.id) ||
        typeof f.workspaceId !== "string" || !WORKSPACE.test(f.workspaceId) ||
        typeof f.expectedBranch !== "string" || !BRANCH.test(f.expectedBranch) ||
        f.expectedBranch.includes("..") ||
        typeof f.ownerScope !== "string" || f.ownerScope.length < 1 ||
        f.ownerScope.length > 256 || !Array.isArray(f.taskIds) ||
        f.taskIds.length < 1 || f.taskIds.length > 64 ||
        !f.taskIds.every(id => typeof id === "string" && ID.test(id)) ||
        new Set(f.taskIds).size !== f.taskIds.length) {
      throw new Error("CAMPAIGN_SERVICE_INVALID: factory declaration");
    }
    seen.add(f.id);
    factories.push({
      id: f.id, kind: "git-clean-inspect-v1", workspaceId: f.workspaceId,
      expectedBranch: f.expectedBranch, ownerScope: f.ownerScope,
      taskIds: [...f.taskIds],
    });
  }
  return {
    version: 1, policyPath: absolute(c.policyPath, "policyPath"),
    stateDirectory: absolute(c.stateDirectory, "stateDirectory"),
    maxEpochs: budget(c.maxEpochs, 64, "maxEpochs"),
    maxWakesPerEpoch: budget(c.maxWakesPerEpoch, 1024, "maxWakesPerEpoch"),
    factories,
  };
}

/** The root-owned configuration and policy must not be symlinks or mutable by
 * the service user. No module names, shell commands or arbitrary tool data
 * can be supplied through the configuration.
 */
async function trustedFile(file: string, expectedUid: number, privateFile: boolean): Promise<void> {
  const info = await lstat(file);
  const parent = await lstat(path.dirname(file));
  if (!info.isFile() || info.isSymbolicLink() || !parent.isDirectory() ||
      parent.isSymbolicLink() || info.uid !== expectedUid ||
      parent.uid !== expectedUid ||
      (process.platform !== "win32" &&
        ((info.mode & (privateFile ? 0o037 : 0o022)) !== 0 ||
          (parent.mode & 0o022) !== 0)) ||
      (process.platform !== "win32" && await realpath(file) !== file)) {
    throw new Error("CAMPAIGN_SERVICE_UNTRUSTED_CONFIG");
  }
}

/** Explicitly invoked by a pre-authorized systemd service, never by
 * LocalAgent.create() or any public MCP tool. No implicit enrollment.
 */
export async function runTrustedCampaignService(
  configPath: string,
  options: TrustedServiceOptions = {},
): Promise<TrustedCampaignProcessReport> {
  const expectedUid = options.configOwnerUid ?? 0;
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
      (process.platform !== "linux" && options.configOwnerUid === undefined)) {
    throw new Error("CAMPAIGN_SERVICE_UNSUPPORTED_PLATFORM");
  }
  const normalized = absolute(configPath, "configPath");
  await trustedFile(normalized, expectedUid, true);
  const config = parseConfig(JSON.parse(await readFile(normalized, "utf8")));
  await trustedFile(config.policyPath, expectedUid, false);
  const state = await lstat(config.stateDirectory);
  if (!state.isDirectory() || state.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (state.mode & 0o077) !== 0) ||
      (process.platform !== "win32" &&
        await realpath(config.stateDirectory) !== config.stateDirectory)) {
    throw new Error("CAMPAIGN_SERVICE_UNTRUSTED_STATE");
  }
  if (process.getuid && state.uid !== process.getuid()) {
    throw new Error("CAMPAIGN_SERVICE_UNTRUSTED_STATE_OWNER");
  }
  if (options.signal?.aborted) {
    return { stop: "stopped", epochs: 0, wakes: 0, campaigns: [] };
  }
  const auditRoot = path.join(config.stateDirectory, "audit");
  const taskRoot = path.join(auditRoot, "background-tasks");
  if ((process.env.VS_CODE_GPT_DATA_DIR &&
        path.resolve(process.env.VS_CODE_GPT_DATA_DIR) !== auditRoot) ||
      (process.env.VS_CODE_GPT_BACKGROUND_TASKS_DIR &&
        path.resolve(process.env.VS_CODE_GPT_BACKGROUND_TASKS_DIR) !== taskRoot)) {
    throw new Error("CAMPAIGN_SERVICE_UNTRUSTED_RUNTIME_STATE");
  }
  process.env.VS_CODE_GPT_DATA_DIR = auditRoot;
  const factories: TrustedCampaignBindingFactories = new Map(config.factories.map(f => [
    f.id,
    {
      ownerScope: f.ownerScope,
      bind: async (agent, record) => {
        if (record.workspaceId !== f.workspaceId ||
            record.tasks.length !== f.taskIds.length ||
            record.tasks.some(t => t.action !== "inspect" ||
              !f.taskIds.includes(t.id))) {
          throw new Error("CAMPAIGN_SERVICE_BINDING_DENIED");
        }
        const bound = bindGitCleanInspection(agent, {
          workspaceId: f.workspaceId,
          root: ".",
          expectedBranch: f.expectedBranch,
        }, { ownerScope: f.ownerScope });
        return new Map(f.taskIds.map(taskId => [taskId, bound.capability]));
      },
    },
  ]));
  const agent = await LocalAgent.create(config.policyPath);
  const catalog = new TrustedCampaignEnrollmentCatalog(config.stateDirectory);
  const host = new TrustedCampaignProcessHost(agent, catalog, factories, {
    stateDirectory: config.stateDirectory,
  });
  try {
    return await host.run(options.signal, {
      maxEpochs: config.maxEpochs,
      maxWakesPerEpoch: config.maxWakesPerEpoch,
    });
  } finally {
    await host.shutdown();
  }
}
