import { SshWorkspaceExecutor } from "@vs-code-gpt/local-agent";
import { createServer } from "node:http";
import { createGatewayApplication } from "./app.js";
import { loadGatewayConfig } from "./config.js";

const config = loadGatewayConfig();
const sshWorkspace = config.workspaceBackend.kind === "ssh"
  ? await SshWorkspaceExecutor.create({
      policyPath: config.workspaceBackend.policyPath,
      backgroundStateDirectory: config.workspaceBackend.backgroundStateDirectory,
      transportConfig: {
        host: config.workspaceBackend.host,
        port: config.workspaceBackend.port,
        username: config.workspaceBackend.username,
        privateKeyPath: config.workspaceBackend.privateKeyPath,
        knownHostsPath: config.workspaceBackend.knownHostsPath,
        connectTimeoutMs: config.workspaceBackend.connectTimeoutMs,
      },
    })
  : undefined;
const gateway = createGatewayApplication(
  config,
  sshWorkspace
    ? {
        workspaceExecutor: sshWorkspace,
        sourceControlExecutor: sshWorkspace,
        workspaceReady: () => sshWorkspace.isReady(),
      }
    : {},
);
const server = createServer(gateway.app);

server.on("upgrade", (request, socket, head) => {
  if (config.workspaceBackend.kind !== "relay") {
    socket.destroy();
    return;
  }
  gateway.relay?.handleUpgrade(request, socket, head);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, "0.0.0.0", () => {
    server.off("error", reject);
    resolve();
  });
});

gateway.logger.info({ event: "gateway_started", port: config.port });

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  gateway.logger.info({ event: "gateway_stopping" });
  gateway.relay?.close();
  server.close((error) => {
    if (error) {
      gateway.logger.error({ event: "gateway_stop_failed", reason: error.name });
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
