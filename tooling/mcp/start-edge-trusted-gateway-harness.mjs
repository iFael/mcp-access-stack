import { createServer } from "node:http";
import { createGatewayApplication } from "../../services/mcp-gateway/dist/app.js";
import { loadGatewayConfig } from "../../services/mcp-gateway/dist/config.js";

const internalAssertion = process.env.MCP_TEST_EDGE_ASSERTION?.trim();
if (!internalAssertion) {
  throw new Error("MCP_TEST_EDGE_ASSERTION is required.");
}

const config = loadGatewayConfig(process.env);
const executor = new Proxy({}, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (value !== undefined) return value;
    if (typeof property !== "string") return value;
    return async () => {
      throw new Error(`Unexpected harness executor call: ${property}`);
    };
  },
});

const gateway = createGatewayApplication(config, {
  workspaceExecutor: executor,
  sourceControlExecutor: executor,
  workspaceReady: () => true,
  edgeTrust: { internalAssertion },
});

const server = createServer(gateway.app);
let closing = false;

const close = async () => {
  if (closing) return;
  closing = true;
  await gateway.close().catch(() => undefined);
  await new Promise((resolve) => server.close(() => resolve()));
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

server.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

server.listen(config.port, "127.0.0.1");
