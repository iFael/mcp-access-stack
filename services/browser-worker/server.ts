import { BrowserWorkerApplication } from "./controllers/browser-worker-application.js";
import { loadBrowserWorkerConfig } from "./config/browser-worker-config.js";
import { createBrowserWorkerHttpServer } from "./infrastructure/browser-worker-http-server.js";
import { BrowserOperationTelemetry } from "./infrastructure/browser-operation-telemetry.js";
import { BrowserRuntime } from "./services/browser-runtime.js";

const config = loadBrowserWorkerConfig();
const telemetry = new BrowserOperationTelemetry(config.runtimeDirectory);
const runtime = await BrowserRuntime.create(config, undefined, { telemetry });
const application = new BrowserWorkerApplication(config, runtime, telemetry);
const server = createBrowserWorkerHttpServer(application);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => {
    server.off("error", reject);
    resolve();
  });
});

process.stderr.write(`${JSON.stringify({
  event: "browser_worker_started",
  host: config.host,
  port: config.port,
  engine: "playwright-direct",
  profileMode: config.profileMode ?? "persistent",
  browserChannel: config.browserChannel ?? "chromium",
})}\n`);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void runtime.shutdown().finally(() => {
    server.close((error) => {
      if (error) process.exitCode = 1;
    });
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
