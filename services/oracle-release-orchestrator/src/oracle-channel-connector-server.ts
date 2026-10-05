import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OracleChannelConnector,
  parseOracleChannelConnectorConfig,
} from "./oracle-channel-connector.js";

async function main(): Promise<void> {
  let config;
  try {
    config = parseOracleChannelConnectorConfig();
  } catch {
    process.stderr.write("update-control-oracle-channel-connector: configuration is unavailable or invalid\n");
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new OracleChannelConnector(config).run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().catch(() => {
    process.stderr.write("update-control-oracle-channel-connector: stopped after an internal failure\n");
    process.exitCode = 1;
  });
}
