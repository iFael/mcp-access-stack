import { MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS } from "@vs-code-gpt/shared";
import { z } from "zod";

const MAX_REQUEST_TIMEOUT_MS = MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS;
const MAX_CONCURRENCY = 4;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type GptActionsWorkspaceId = string;

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const cappedInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(defaultValue);

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    PUBLIC_BASE_URL: z.url(),
    AUTH_MODE: z.enum(["oauth", "none", "owner"]).default("oauth"),
    OWNER_TOKEN: z.string().trim().min(16).optional(),
    OWNER_OAUTH_SCOPES: z.string().trim().min(1).default("workspaces:read"),
    OWNER_OAUTH_STATE_PATH: z.string().trim().min(1).optional(),
    OWNER_ACCESS_TOKEN_TTL_SECONDS: positiveInteger(3600),
    OWNER_REFRESH_TOKEN_TTL_SECONDS: positiveInteger(2_592_000),
    MCP_PATH: z
      .string()
      .regex(
        /^\/[A-Za-z0-9_-]+$/,
        "MCP_PATH must be a single path segment such as /mcp or /mcp-a8f3k2x9.",
      )
      .default("/mcp"),
    TRUST_PROXY: z.coerce.number().int().min(0).max(16).default(0),
    OAUTH_ISSUER: z.url().optional(),
    OAUTH_AUDIENCE: z.string().trim().min(1).optional(),
    OAUTH_JWKS_URL: z.url().optional(),
    OAUTH_ALLOWED_SUBJECTS: z.string().trim().min(1).optional(),
    OAUTH_REQUIRED_SCOPE: z.string().trim().min(1).default("workspaces:read"),
    ALLOWED_ORIGINS: z.string().default(""),
    AGENT_ID: z.string().trim().min(1).max(128).optional(),
    AGENT_TOKEN_SHA256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    AGENT_REQUEST_TIMEOUT_MS: cappedInteger(60_000, MAX_REQUEST_TIMEOUT_MS),
    AGENT_HEARTBEAT_MS: positiveInteger(30_000),
    AGENT_MAX_CONCURRENCY: cappedInteger(4, MAX_CONCURRENCY),
    AGENT_MAX_PAYLOAD_BYTES: cappedInteger(MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES),
    WORKSPACE_BACKEND: z.enum(["relay", "ssh", "in-process"]).default("relay"),
    SSH_WORKSPACE_HOST: z.string().trim().min(1).optional(),
    SSH_WORKSPACE_PORT: z.coerce.number().int().min(1).max(65_535).default(22),
    SSH_WORKSPACE_USERNAME: z.string().trim().min(1).optional(),
    SSH_WORKSPACE_PRIVATE_KEY_PATH: z.string().trim().min(1).optional(),
    SSH_WORKSPACE_KNOWN_HOSTS_PATH: z.string().trim().min(1).optional(),
    SSH_WORKSPACE_POLICY_PATH: z.string().trim().min(1).optional(),
    SSH_WORKSPACE_CONNECT_TIMEOUT_MS: cappedInteger(15_000, 120_000),
    SSH_WORKSPACE_BACKGROUND_STATE_DIR: z.string().trim().min(1).default("/var/lib/mcp-access-stack/background-tasks"),
    BROWSER_WORKER_ENABLED: z.stringbool().default(false),
    BROWSER_WORKER_ALLOW_DOCKER_HOST: z.stringbool().default(false),
    BROWSER_WORKER_ALLOWED_HOSTS: z.string().default(""),
    BROWSER_WORKER_URL: z.url().default("http://127.0.0.1:3350"),
    BROWSER_WORKER_TOKEN: z.string().min(32).optional(),
    BROWSER_WORKER_TIMEOUT_MS: cappedInteger(120_000, MAX_REQUEST_TIMEOUT_MS),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: cappedInteger(
      4 * 1024 * 1024,
      MAX_BROWSER_PAYLOAD_BYTES,
    ),
    GPT_ACTIONS_ENABLED: z.stringbool().default(false),
    GPT_ACTIONS_TOKEN_SHA256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    GPT_ACTIONS_WORKSPACE_IDS: z.string().trim().default(""),
    GPT_ACTIONS_ALLOW_WRITE: z.stringbool().default(false),
    GPT_ACTIONS_ALLOW_SHELL: z.stringbool().default(false),
    RATE_LIMIT_WINDOW_MS: positiveInteger(60_000),
    RATE_LIMIT_MAX: positiveInteger(60),
    LOG_LEVEL: z.string().trim().min(1).default("info"),
  })
  .strict();

const KNOWN_VARIABLES = Object.keys(configSchema.shape) as Array<
  keyof typeof configSchema.shape
>;

const RESERVED_MCP_PATHS = new Set(["/agent", "/health"]);

export interface GatewayOAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  allowedSubjects: ReadonlySet<string>;
  requiredScope: string;
}

export interface GatewayOwnerOAuthConfig {
  ownerToken: string;
  scopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  statePath?: string;
  resourceName: string;
}

export interface GatewayBrowserWorkerConfig {
  url: URL;
  token: string;
  timeoutMs: number;
  maxPayloadBytes: number;
}

export interface GatewayActionsConfig {
  tokenSha256: string;
  workspaceIds: readonly GptActionsWorkspaceId[];
  allowWrite: boolean;
  allowShell: boolean;
}

export type GatewayWorkspaceBackendConfig =
  | { kind: "relay" }
  | { kind: "in-process" }
  | {
      kind: "ssh";
      host: string;
      port: number;
      username: string;
      privateKeyPath: string;
      knownHostsPath: string;
      policyPath: string;
      connectTimeoutMs: number;
      backgroundStateDirectory: string;
    };
export interface GatewayConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  publicBaseUrl: URL;
  authMode: "oauth" | "none" | "owner";
  mcpPath: string;
  trustProxy: number;
  oauth?: GatewayOAuthConfig | undefined;
  ownerOAuth?: GatewayOwnerOAuthConfig | undefined;
  browserWorker?: GatewayBrowserWorkerConfig | undefined;
  actions?: GatewayActionsConfig | undefined;
  allowedOrigins: ReadonlySet<string>;
  workspaceBackend: GatewayWorkspaceBackendConfig;
  agent: {
    id?: string;
    tokenSha256?: string;
    requestTimeoutMs: number;
    heartbeatMs: number;
    maxConcurrency: number;
    maxPayloadBytes: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  logLevel: string;
}

export function loadGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const input: Record<string, string> = {};
  for (const variable of KNOWN_VARIABLES) {
    const raw = environment[variable];
    if (raw !== undefined) input[variable] = raw;
  }
  const value = configSchema.parse(input);
  if (
    value.WORKSPACE_BACKEND === "relay" &&
    (!value.AGENT_ID || !value.AGENT_TOKEN_SHA256)
  ) {
    throw new Error("WORKSPACE_BACKEND=relay requires AGENT_ID and AGENT_TOKEN_SHA256.");
  }
  const publicBaseUrl = new URL(value.PUBLIC_BASE_URL);
  if (publicBaseUrl.username || publicBaseUrl.password || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must not contain credentials, query parameters, or fragments.");
  }
  if (value.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
  }
  if (RESERVED_MCP_PATHS.has(value.MCP_PATH)) {
    throw new Error("MCP_PATH must not collide with the /agent or /health endpoints.");
  }
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    publicBaseUrl,
    authMode: value.AUTH_MODE,
    mcpPath: value.MCP_PATH,
    trustProxy: value.TRUST_PROXY,
    oauth: loadOAuthConfig(value),
    ownerOAuth: loadOwnerOAuthConfig(value),
    browserWorker: loadBrowserWorkerConfig(value),
    actions: loadActionsConfig(value),
    allowedOrigins: parseSet(value.ALLOWED_ORIGINS),
    workspaceBackend: loadWorkspaceBackendConfig(value),
    agent: {
      ...(value.AGENT_ID === undefined ? {} : { id: value.AGENT_ID }),
      ...(value.AGENT_TOKEN_SHA256 === undefined
        ? {}
        : { tokenSha256: value.AGENT_TOKEN_SHA256.toLowerCase() }),
      requestTimeoutMs: value.AGENT_REQUEST_TIMEOUT_MS,
      heartbeatMs: value.AGENT_HEARTBEAT_MS,
      maxConcurrency: value.AGENT_MAX_CONCURRENCY,
      maxPayloadBytes: value.AGENT_MAX_PAYLOAD_BYTES,
    },
    rateLimit: {
      windowMs: value.RATE_LIMIT_WINDOW_MS,
      max: value.RATE_LIMIT_MAX,
    },
    logLevel: value.LOG_LEVEL,
  };
}

function loadWorkspaceBackendConfig(
  value: z.infer<typeof configSchema>,
): GatewayWorkspaceBackendConfig {
  if (value.WORKSPACE_BACKEND === "relay") return { kind: "relay" };
  if (value.WORKSPACE_BACKEND === "in-process") return { kind: "in-process" };
  const required = {
    SSH_WORKSPACE_HOST: value.SSH_WORKSPACE_HOST,
    SSH_WORKSPACE_USERNAME: value.SSH_WORKSPACE_USERNAME,
    SSH_WORKSPACE_PRIVATE_KEY_PATH: value.SSH_WORKSPACE_PRIVATE_KEY_PATH,
    SSH_WORKSPACE_KNOWN_HOSTS_PATH: value.SSH_WORKSPACE_KNOWN_HOSTS_PATH,
    SSH_WORKSPACE_POLICY_PATH: value.SSH_WORKSPACE_POLICY_PATH,
  };
  for (const [name, configured] of Object.entries(required)) {
    if (!configured) throw new Error(`WORKSPACE_BACKEND=ssh requires ${name}.`);
  }
  return {
    kind: "ssh",
    host: required.SSH_WORKSPACE_HOST!,
    port: value.SSH_WORKSPACE_PORT,
    username: required.SSH_WORKSPACE_USERNAME!,
    privateKeyPath: required.SSH_WORKSPACE_PRIVATE_KEY_PATH!,
    knownHostsPath: required.SSH_WORKSPACE_KNOWN_HOSTS_PATH!,
    policyPath: required.SSH_WORKSPACE_POLICY_PATH!,
    connectTimeoutMs: value.SSH_WORKSPACE_CONNECT_TIMEOUT_MS,
    backgroundStateDirectory: value.SSH_WORKSPACE_BACKGROUND_STATE_DIR,
  };
}
function loadActionsConfig(
  value: z.infer<typeof configSchema>,
): GatewayActionsConfig | undefined {
  if (!value.GPT_ACTIONS_ENABLED) return undefined;
  if (!value.GPT_ACTIONS_TOKEN_SHA256) {
    throw new Error(
      "GPT_ACTIONS_ENABLED=true requires GPT_ACTIONS_TOKEN_SHA256.",
    );
  }

  const configuredIds = [...parseSet(value.GPT_ACTIONS_WORKSPACE_IDS)];
  if (configuredIds.length === 0) {
    throw new Error("GPT_ACTIONS_WORKSPACE_IDS must not be empty.");
  }
  return {
    tokenSha256: value.GPT_ACTIONS_TOKEN_SHA256.toLowerCase(),
    workspaceIds: configuredIds as GptActionsWorkspaceId[],
    allowWrite: value.GPT_ACTIONS_ALLOW_WRITE,
    allowShell: value.GPT_ACTIONS_ALLOW_SHELL,
  };
}

function loadBrowserWorkerConfig(
  value: z.infer<typeof configSchema>,
): GatewayBrowserWorkerConfig | undefined {
  if (!value.BROWSER_WORKER_ENABLED) return undefined;
  if (!value.BROWSER_WORKER_TOKEN) {
    throw new Error("BROWSER_WORKER_ENABLED=true requires BROWSER_WORKER_TOKEN.");
  }
  const url = new URL(value.BROWSER_WORKER_URL);
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (value.BROWSER_WORKER_ALLOW_DOCKER_HOST) {
    allowedHosts.add("host.docker.internal");
  }
  for (const host of parseSet(value.BROWSER_WORKER_ALLOWED_HOSTS)) {
    allowedHosts.add(host.toLocaleLowerCase("en-US"));
  }
  if (
    url.protocol !== "http:" ||
    !allowedHosts.has(url.hostname.toLocaleLowerCase("en-US")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "BROWSER_WORKER_URL must be a loopback HTTP URL, or host.docker.internal when BROWSER_WORKER_ALLOW_DOCKER_HOST=true.",
    );
  }
  return {
    url,
    token: value.BROWSER_WORKER_TOKEN,
    timeoutMs: value.BROWSER_WORKER_TIMEOUT_MS,
    maxPayloadBytes: value.BROWSER_WORKER_MAX_PAYLOAD_BYTES,
  };
}

function loadOAuthConfig(
  value: z.infer<typeof configSchema>,
): GatewayOAuthConfig | undefined {
  if (value.AUTH_MODE !== "oauth") return undefined;
  if (
    !value.OAUTH_ISSUER ||
    !value.OAUTH_AUDIENCE ||
    !value.OAUTH_JWKS_URL ||
    !value.OAUTH_ALLOWED_SUBJECTS
  ) {
    throw new Error(
      "AUTH_MODE=oauth requires OAUTH_ISSUER, OAUTH_AUDIENCE, OAUTH_JWKS_URL, and OAUTH_ALLOWED_SUBJECTS.",
    );
  }
  return {
    issuer: value.OAUTH_ISSUER,
    audience: value.OAUTH_AUDIENCE,
    jwksUrl: new URL(value.OAUTH_JWKS_URL),
    allowedSubjects: parseSet(value.OAUTH_ALLOWED_SUBJECTS),
    requiredScope: value.OAUTH_REQUIRED_SCOPE,
  };
}

function loadOwnerOAuthConfig(
  value: z.infer<typeof configSchema>,
): GatewayOwnerOAuthConfig | undefined {
  if (value.AUTH_MODE !== "owner") return undefined;
  if (!value.OWNER_TOKEN) {
    throw new Error("AUTH_MODE=owner requires OWNER_TOKEN (min 16 characters).");
  }
  const scopes = value.OWNER_OAUTH_SCOPES.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    ownerToken: value.OWNER_TOKEN,
    scopes: scopes.length > 0 ? scopes : ["workspaces:read"],
    accessTokenTtlSeconds: value.OWNER_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: value.OWNER_REFRESH_TOKEN_TTL_SECONDS,
    ...(value.OWNER_OAUTH_STATE_PATH === undefined ? {} : { statePath: value.OWNER_OAUTH_STATE_PATH }),
    resourceName: "MCP VS CODE - GPT",
  };
}

function parseSet(value: string): ReadonlySet<string> {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}
