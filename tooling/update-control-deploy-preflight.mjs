import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATE_CONTROL_DEPLOY_SECRET_INPUTS = Object.freeze([
  "UPDATE_CONTROL_CF_API_TOKEN",
  "ORACLE_ACCESS_CLIENT_SECRET",
  "UPDATE_CONTROL_ORCHESTRATOR_TOKEN",
]);

export const UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "ORACLE_ACCESS_CLIENT_ID",
  "MCP_UPDATE_CONTROL_PUBLIC_URL",
  "ORCHESTRATOR_READ_API_URL",
  "UPDATE_CONTROL_OAUTH_REPROVISION_URL",
  "UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_ISSUER",
  "UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE",
]);

function isMissing(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function containsControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isHttpsOrigin(value, { rejectWorkersDev = false } = {}) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      (!rejectWorkersDev || (hostname !== "workers.dev" && !hostname.endsWith(".workers.dev")));
  } catch {
    return false;
  }
}

function getHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isReprovisionUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/_operations/oauth/reprovision" &&
      url.hostname.toLowerCase() !== "workers.dev" &&
      !url.hostname.toLowerCase().endsWith(".workers.dev") &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

function settingError(kind, name, value, valid) {
  if (isMissing(value)) return `Required GitHub Environment ${kind} ${name} is missing.`;
  if (!valid(value)) return `Required GitHub Environment ${kind} ${name} is invalid.`;
  return undefined;
}

/**
 * Validates the protected Environment inputs needed for the normal Update Control Worker deploy.
 * Error messages contain setting names and classifications only; values are never returned or logged.
 * MCP_OWNER_TOKEN and OAuth-operation service-token credentials intentionally belong to the separate
 * controlled OAuth workflow and are not normal-deploy inputs.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateUpdateControlDeployEnvironment(env) {
  const errors = [];
  const cleanText = (minimum, maximum) => (value) =>
    value.length >= minimum && value.length <= maximum && !containsControlCharacters(value);

  const secretValidators = {
    UPDATE_CONTROL_CF_API_TOKEN: cleanText(1, 4096),
    ORACLE_ACCESS_CLIENT_SECRET: cleanText(32, 2048),
    UPDATE_CONTROL_ORCHESTRATOR_TOKEN: cleanText(32, 2048),
  };
  for (const name of UPDATE_CONTROL_DEPLOY_SECRET_INPUTS) {
    const error = settingError("secret", name, env[name], secretValidators[name]);
    if (error) errors.push(error);
  }

  const variableValidators = {
    CLOUDFLARE_ACCOUNT_ID: (value) => /^[a-f0-9]{32}$/iu.test(value),
    ORACLE_ACCESS_CLIENT_ID: cleanText(8, 1024),
    MCP_UPDATE_CONTROL_PUBLIC_URL: (value) => isHttpsOrigin(value, { rejectWorkersDev: true }),
    ORCHESTRATOR_READ_API_URL: (value) => isHttpsOrigin(value, { rejectWorkersDev: true }),
    UPDATE_CONTROL_OAUTH_REPROVISION_URL: isReprovisionUrl,
    UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_ISSUER: isHttpsOrigin,
    UPDATE_CONTROL_OAUTH_REPROVISION_ACCESS_AUDIENCE: cleanText(1, 512),
  };
  for (const name of UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS) {
    const error = settingError("variable", name, env[name], variableValidators[name]);
    if (error) errors.push(error);
  }

  const publicOrigin = getHttpsOrigin(env.MCP_UPDATE_CONTROL_PUBLIC_URL ?? "");
  let operationsOrigin;
  try {
    operationsOrigin = new URL(env.UPDATE_CONTROL_OAUTH_REPROVISION_URL ?? "").origin;
  } catch {
    operationsOrigin = undefined;
  }
  if (publicOrigin && operationsOrigin && publicOrigin === operationsOrigin) {
    errors.push("Required GitHub Environment variable UPDATE_CONTROL_OAUTH_REPROVISION_URL must use a distinct origin from MCP_UPDATE_CONTROL_PUBLIC_URL.");
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
