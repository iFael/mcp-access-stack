import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import type { OracleControlCallerBinding } from "./oracle-control-caller.js";

const ENABLE = "MCP_V3_ORACLE_CONTROL_ENABLED";
const URL = "MCP_V3_ORACLE_CONTROL_ENDPOINT";
const KEY_FILE = "MCP_V3_ORACLE_CONTROL_HMAC_FILE";
const OWNER = "MCP_V3_ORACLE_CONTROL_OWNER_SCOPE";
const HEX = /^[0-9a-f]{64}$/u;

/**
 * A deliberate host-side enrollment only for the authenticated Linux Edge
 * connector. This is not read from user/tool input and does not grant the
 * systemd Oracle read-only service permission to mutate.
 */
export async function loadOracleControlBindingFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<OracleControlCallerBinding | undefined> {
  const names = [ENABLE, URL, KEY_FILE, OWNER] as const;
  const configured = names.some(name => environment[name] !== undefined);
  if (!configured) return undefined;
  if (environment[ENABLE] !== "1") {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle control enrollment is not authorized on this host.");
  }
  const endpoint = environment[URL]?.trim();
  const credentialPath = environment[KEY_FILE]?.trim();
  const authorizedOwnerScope = environment[OWNER]?.trim();
  if (!endpoint || !credentialPath || !authorizedOwnerScope ||
      authorizedOwnerScope.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(authorizedOwnerScope)) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle control host configuration is incomplete.");
  }
  if (process.platform !== "linux") {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle control enrollment is not authorized on this host.");
  }
  // Both the URL and scope are immutable within this host process. The
  // caller still applies its independent exact HTTPS workers.dev allowlist.
  const readKey = async (): Promise<string> => {
    try {
      if (!isAbsolute(credentialPath)) throw new Error("relative");
      const metadata = await lstat(credentialPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not_regular");
      const mode = metadata.mode & 0o777;
      const protectedFile = (mode & 0o077) === 0;
      const credentialDirectory = environment.CREDENTIALS_DIRECTORY?.trim();
      const trustedSystemd = mode === 0o440 &&
        credentialDirectory !== undefined && isAbsolute(credentialDirectory) &&
        (await realpath(dirname(credentialPath))) === (await realpath(credentialDirectory));
      if (!protectedFile && !trustedSystemd) throw new Error("permissions");
      const file = await open(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const observed = await file.stat();
        if (!observed.isFile() || observed.dev !== metadata.dev ||
          observed.ino !== metadata.ino || observed.size < 64 || observed.size > 66) {
          throw new Error("file_changed");
        }
        const raw = await file.readFile({encoding:"utf8"});
        const secret = raw.endsWith("\r\n") ? raw.slice(0,-2)
          : raw.endsWith("\n") ? raw.slice(0,-1) : raw;
        if (!HEX.test(secret)) throw new Error("invalid_key");
        return secret;
      } finally { await file.close(); }
    } catch {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle control credential is unavailable.");
    }
  };

  // Deny misconfiguration before constructing the local agent. No bytes are
  // logged, serialized or copied into long-lived options.
  await readKey();
  return {
    endpoint,
    key:readKey,
    authorize:async (_request,ownerScope) => ownerScope === authorizedOwnerScope,
  };
}
