import { MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS } from "@vs-code-gpt/shared";
import { z } from "zod";

const MAX_REQUEST_TIMEOUT_MS = MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_PAYLOAD_BYTES = 16 * 1024 * 1024;

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const cappedInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(defaultValue);

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    PUBLIC_BASE_URL: z.url(),
    MCP_PATH: z
      .string()
      .regex(
        /^\/[A-Za-z0-9_-]+$/,
        "MCP_PATH must be a single path segment such as /mcp or /mcp-a8f3k2x9.",
      )
      .default("/mcp"),
    TRUST_PROXY: z.coerce.number().int().min(0).max(16).default(0),
    ALLOWED_ORIGINS: z.string().default(""),
    BROWSER_WORKER_ENABLED: z.stringbool().default(false),
    BROWSER_WORKER_ALLOWED_HOSTS: z.string().default(""),
    BROWSER_WORKER_URL: z.url().default("http://127.0.0.1:3350"),
    BROWSER_WORKER_TOKEN: z.string().min(32).optional(),
    BROWSER_WORKER_TIMEOUT_MS: cappedInteger(120_000, MAX_REQUEST_TIMEOUT_MS),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: cappedInteger(
      4 * 1024 * 1024,
      MAX_BROWSER_PAYLOAD_BYTES,
    ),
    RATE_LIMIT_WINDOW_MS: positiveInteger(60_000),
    RATE_LIMIT_MAX: positiveInteger(60),
    LOG_LEVEL: z.string().trim().min(1).default("info"),
  })
  .strict();

const KNOWN_VARIABLES = Object.keys(configSchema.shape) as Array<
  keyof typeof configSchema.shape
>;

const RESERVED_MCP_PATHS = new Set(["/health"]);

export interface GatewayBrowserWorkerConfig {
  url: URL;
  token: string;
  timeoutMs: number;
  maxPayloadBytes: number;
}

export interface GatewayConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  publicBaseUrl: URL;
  mcpPath: string;
  trustProxy: number;
  browserWorker?: GatewayBrowserWorkerConfig | undefined;
  allowedOrigins: ReadonlySet<string>;
  maxPayloadBytes: number;
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
  const publicBaseUrl = new URL(value.PUBLIC_BASE_URL);
  if (
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must not contain credentials, query parameters, or fragments.",
    );
  }
  if (value.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
  }
  if (RESERVED_MCP_PATHS.has(value.MCP_PATH)) {
    throw new Error("MCP_PATH must not collide with the /health endpoint.");
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    publicBaseUrl,
    mcpPath: value.MCP_PATH,
    trustProxy: value.TRUST_PROXY,
    browserWorker: loadBrowserWorkerConfig(value),
    allowedOrigins: parseSet(value.ALLOWED_ORIGINS),
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    rateLimit: {
      windowMs: value.RATE_LIMIT_WINDOW_MS,
      max: value.RATE_LIMIT_MAX,
    },
    logLevel: value.LOG_LEVEL,
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
      "BROWSER_WORKER_URL must be an allowed loopback HTTP URL.",
    );
  }
  return {
    url,
    token: value.BROWSER_WORKER_TOKEN,
    timeoutMs: value.BROWSER_WORKER_TIMEOUT_MS,
    maxPayloadBytes: value.BROWSER_WORKER_MAX_PAYLOAD_BYTES,
  };
}

function parseSet(value: string): ReadonlySet<string> {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}
