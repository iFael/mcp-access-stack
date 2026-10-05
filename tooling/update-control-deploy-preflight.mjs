import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATE_CONTROL_DEPLOY_SECRET_INPUTS = Object.freeze([
  "UPDATE_CONTROL_CF_API_TOKEN",
  "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN",
]);

export const UPDATE_CONTROL_DEPLOY_VARIABLE_INPUTS = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "MCP_UPDATE_CONTROL_PUBLIC_URL",
]);

function isMissing(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function containsControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isWorkersDevOrigin(value) {
  try {
    if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes("?") || value.includes("#")) return false;
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isRootOrigin = value === url.origin || value === `${url.origin}/`;
    return url.protocol === "https:" &&
      isRootOrigin &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      hostname !== "workers.dev" &&
      hostname.endsWith(".workers.dev");
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
 * MCP_OWNER_TOKEN belongs to the separate controlled OAuth workflow and is not a normal-deploy input.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateUpdateControlDeployEnvironment(env) {
  const errors = [];
  const cleanText = (minimum, maximum) => (value) =>
    value.length >= minimum && value.length <= maximum && !containsControlCharacters(value);

  const secretValidators = {
    UPDATE_CONTROL_CF_API_TOKEN: cleanText(1, 4096),
    UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: cleanText(32, 2048),
  };
  for (const name of UPDATE_CONTROL_DEPLOY_SECRET_INPUTS) {
    const error = settingError("secret", name, env[name], secretValidators[name]);
    if (error) errors.push(error);
  }

  const variableValidators = {
    CLOUDFLARE_ACCOUNT_ID: (value) => /^[a-f0-9]{32}$/iu.test(value),
    MCP_UPDATE_CONTROL_PUBLIC_URL: isWorkersDevOrigin,
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
