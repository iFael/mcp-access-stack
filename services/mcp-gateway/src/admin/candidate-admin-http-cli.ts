#!/usr/bin/env node
/**
 * Local loopback-only HTTP transport for the READ-ONLY candidate-99 administrator.
 * Public exposure, TLS/OAuth, reverse proxy, service deployment and registration
 * are intentionally NOT performed by this command.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { createCandidateAdminHttpApp } from "./candidate-admin-http.js";

const TOKEN_PATH = "/var/lib/mcp-access-stack/secrets/connector99-admin-token";
const PORT = 39199;

export async function loadPrivateAdminToken(path = TOKEN_PATH): Promise<string> {
  if (process.platform !== "linux" || !process.getuid || process.getuid() === 0) {
    throw Error("PRIVATE_ADMIN_LOCAL_LINUX_OPERATOR_REQUIRED");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0 ||
        metadata.size > 300 || metadata.size < 48) {
      throw Error("PRIVATE_ADMIN_CREDENTIAL_FILE_UNTRUSTED");
    }
    const token = (await handle.readFile({ encoding: "utf8" })).trimEnd();
    if (!/^[A-Za-z0-9_-]{48,256}$/u.test(token)) throw Error("PRIVATE_ADMIN_CREDENTIAL_INVALID");
    return token;
  } finally {
    await handle.close();
  }
}

export async function runPrivateAdminHttp(): Promise<void> {
  const token = await loadPrivateAdminToken();
  const app = createCandidateAdminHttpApp({ token });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write("candidate99_private_admin_loopback_ready\n");
  const close = () => { server.close(); };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

if (process.argv[1]?.endsWith("candidate-admin-http-cli.js")) {
  runPrivateAdminHttp().catch(() => {
    // Do not log tokens, paths, request contents, or other sensitive details.
    process.stderr.write("candidate99_private_admin_start_failed\n");
    process.exitCode = 1;
  });
}
