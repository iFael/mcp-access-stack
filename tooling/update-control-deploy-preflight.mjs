import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATE_CONTROL_DEPLOY_SECRET_INPUTS = Object.freeze([
  "UPDATE_CONTROL_CF_API_TOKEN",
  "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN",
  "UPDATE_CONTROL_ADMIN_HMAC_KEY",
  "UPDATE_CONTROL_TOTP_ENCRYPTION_KEY",
]);

export const UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "MCP_UPDATE_CONTROL_PUBLIC_URL",
  "UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL",
]);

function isMissing(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function containsControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

const UPDATE_CONTROL_WORKER_NAME = "mcp-v3-update-control";

function isWorkersDevOrigin(value) {
  try {
    if (containsControlCharacters(value) || value.includes("?") || value.includes("#")) return false;
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const workerHostPrefix = UPDATE_CONTROL_WORKER_NAME + ".";
    const workersDevSuffix = ".workers.dev";
    const accountSubdomain = hostname.startsWith(workerHostPrefix) && hostname.endsWith(workersDevSuffix)
      ? hostname.slice(workerHostPrefix.length, -workersDevSuffix.length)
      : "";
    const isRootOrigin = value === url.origin || value === `${url.origin}/`;
    return url.protocol === "https:" &&
      isRootOrigin &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      accountSubdomain.length > 0;
  } catch {
    return false;
  }
}

function isBootstrapAdminEmail(value) {
  return value.length >= 3 &&
    value.length <= 320 &&
    !/[\u0000-\u0020\u007f]/u.test(value) &&
    /^[^@]+@[^@]+$/u.test(value);
}

function settingError(kind, name, value, valid) {
  if (isMissing(value)) return `Required GitHub Environment ${kind} ${name} is missing.`;
  if (!valid(value)) return `Required GitHub Environment ${kind} ${name} is invalid.`;
  return undefined;
}

export function validateUpdateControlDeployEnvironment(env) {
  const errors = [];
  const cleanText = (minimum, maximum) => (value) =>
    value.length >= minimum && value.length <= maximum && !containsControlCharacters(value);

  const secretValidators = {
    UPDATE_CONTROL_CF_API_TOKEN: cleanText(1, 4096),
    UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: cleanText(32, 2048),
    UPDATE_CONTROL_ADMIN_HMAC_KEY: (value) => /^[0-9a-f]{64}$/u.test(value),
    UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: (value) => /^[0-9a-f]{64}$/u.test(value),
  };
  for (const name of UPDATE_CONTROL_DEPLOY_SECRET_INPUTS) {
    const error = settingError("secret", name, env[name], secretValidators[name]);
    if (error) errors.push(error);
  }

  const variableValidators = {
    CLOUDFLARE_ACCOUNT_ID: (value) => /^[a-f0-9]{32}$/iu.test(value),
    MCP_UPDATE_CONTROL_PUBLIC_URL: isWorkersDevOrigin,
    UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: isBootstrapAdminEmail,
  };
  for (const name of UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS) {
    const error = settingError("variable", name, env[name], variableValidators[name]);
    if (error) errors.push(error);
  }
  return errors;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const errors = validateUpdateControlDeployEnvironment(process.env);
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
  } else {
    console.log("Update Control deployment configuration preflight passed; values withheld.");
  }
}
