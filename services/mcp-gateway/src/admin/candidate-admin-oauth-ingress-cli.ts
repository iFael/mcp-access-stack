#!/usr/bin/env node
/** HTTPS/OAuth read-only ingress. Local listener only; external exposure is a separate gate. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:https";
import { createCandidateAdminOauthIngressApp } from "./candidate-admin-oauth-ingress.js";

const ROOT = "/var/lib/mcp-access-stack/secrets/";
const PATHS = {
  tlsKey: ROOT + "connector99-oauth-ingress-key.pem",
  tlsCert: ROOT + "connector99-oauth-ingress-cert.pem",
  oauthClientSecret: ROOT + "connector99-oauth-client-secret",
  loopbackToken: ROOT + "connector99-admin-token",
} as const;

export async function readOwnerPrivateFile(path: string, minBytes = 32): Promise<string> {
  if (process.platform !== "linux" || !process.getuid || process.getuid() === 0) {
    throw Error("PRIVATE_INGRESS_LOCAL_NONROOT_REQUIRED");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
        stat.size < minBytes || stat.size > 16384) {
      throw Error("PRIVATE_INGRESS_FILE_UNTRUSTED");
    }
    return (await handle.readFile({ encoding: "utf8" })).trimEnd();
  } finally {
    await handle.close();
  }
}

export async function runPrivateOauthIngress(): Promise<void> {
  const [tlsKey, tlsCert, clientSecret, loopbackToken] = await Promise.all([
    readOwnerPrivateFile(PATHS.tlsKey, 64),
    readOwnerPrivateFile(PATHS.tlsCert, 64),
    readOwnerPrivateFile(PATHS.oauthClientSecret, 32),
    readOwnerPrivateFile(PATHS.loopbackToken, 48),
  ]);
  const app = createCandidateAdminOauthIngressApp({
    publicBaseUrl: process.env.CONNECTOR99_ADMIN_PUBLIC_URL ?? "",
    authorizationServer: process.env.CONNECTOR99_ADMIN_OAUTH_ISSUER ?? "",
    introspectionUrl: process.env.CONNECTOR99_ADMIN_OAUTH_INTROSPECTION_URL ?? "",
    clientId: process.env.CONNECTOR99_ADMIN_OAUTH_CLIENT_ID ?? "",
    clientSecret,
    loopbackToken,
  });
  const server = createServer({ key: tlsKey, cert: tlsCert, minVersion: "TLSv1.2" }, app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Fail closed: external host routing or firewall configuration requires an independent gate.
    server.listen(39200, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write("connector99_private_oauth_https_loopback_ready\n");
  const shutdown = () => server.close();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1]?.endsWith("candidate-admin-oauth-ingress-cli.js")) {
  runPrivateOauthIngress().catch(() => {
    process.stderr.write("connector99_private_oauth_ingress_unavailable\n");
    process.exitCode = 1;
  });
}
