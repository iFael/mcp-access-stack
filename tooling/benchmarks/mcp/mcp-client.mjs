import http from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const clientTimingSymbol = Symbol("mcp-benchmark-client-timing");

export function createFetchTimingRecorder(fetchFn = globalThis.fetch) {
  let generation = 0;
  const records = [];
  return {
    fetch: async (input, init) => {
      const activeGeneration = generation;
      const method = requestMethod(input, init);
      const startedAt = performance.now();
      const response = await Reflect.apply(fetchFn, globalThis, [input, init]);
      if (method === "POST") {
        records.push({
          generation: activeGeneration,
          fetchHeadersMs: round(performance.now() - startedAt),
        });
      }
      return response;
    },
    beginCall() {
      generation += 1;
      return generation;
    },
    readCallTiming(callGeneration = generation) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.generation === callGeneration) {
          return { fetchHeadersMs: records[index].fetchHeadersMs };
        }
      }
      return undefined;
    },
  };
}

export function createLoopbackHttpFetch(routeUrl) {
  const route = new URL(routeUrl);
  if (route.protocol !== "http:" || !isLoopbackHostname(route.hostname)) {
    return { fetch: globalThis.fetch, close() {} };
  }
  const requestAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 1,
    maxFreeSockets: 1,
    scheduling: "fifo",
  });
  const streamAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 1,
    maxFreeSockets: 1,
    scheduling: "fifo",
  });
  return {
    fetch: async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
        return globalThis.fetch(input, init);
      }
      const method = requestMethod(input, init);
      const headers = mergeRequestHeaders(input, init);
      const agent = method === "GET" ? streamAgent : requestAgent;
      return new Promise((resolve, reject) => {
        const request = http.request(url, {
          method,
          headers: Object.fromEntries(headers.entries()),
          agent,
          signal: init.signal,
        }, (response) => {
          resolve(new Response(Readable.toWeb(response), {
            status: response.statusCode ?? 200,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders(response.rawHeaders),
          }));
        });
        request.once("error", reject);
        writeRequestBody(request, init.body);
      });
    },
    close() {
      requestAgent.destroy();
      streamAgent.destroy();
    },
  };
}

export function readMcpBenchmarkClientTiming(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return value[clientTimingSymbol];
}

export class McpBenchmarkClient {
  constructor(route) {
    this.route = route;
    this.client = undefined;
    this.transport = undefined;
    this.fetchResource = route.fetch
      ? { fetch: route.fetch, close() {} }
      : createLoopbackHttpFetch(route.url);
    this.fetchTiming = createFetchTimingRecorder(this.fetchResource.fetch);
  }

  async connect() {
    if (this.client) return;
    const headers = {
      accept: "application/json, text/event-stream",
      ...(this.route.token ? { authorization: `Bearer ${this.route.token}` } : {}),
      ...(this.route.headers ?? {}),
    };
    this.transport = new StreamableHTTPClientTransport(new URL(this.route.url), {
      requestInit: { headers },
      fetch: this.fetchTiming.fetch,
    });
    this.client = new Client(
      { name: "mcp-performance-benchmark", version: "1.0.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async listTools() {
    await this.connect();
    return this.client.listTools();
  }

  async callTool(name, args, options = {}) {
    await this.connect();
    const callGeneration = this.fetchTiming.beginCall();
    const timeout = options.timeoutMs ?? this.route.timeoutMs;
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      timeout === undefined ? undefined : { timeout },
    );
    return attachClientTiming(
      result,
      this.fetchTiming.readCallTiming(callGeneration),
    );
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    try {
      await client?.close();
    } finally {
      this.fetchResource.close();
    }
  }
}

export function sanitizeRoute(route) {
  return {
    name: route.name,
    url: redactUrl(route.url),
  };
}

function attachClientTiming(value, timing) {
  if (!timing || (typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  Object.defineProperty(value, clientTimingSymbol, {
    value: timing,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

function requestUrl(input) {
  if (input instanceof URL) return input;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input);
}

function requestMethod(input, init) {
  if (typeof init?.method === "string") return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function mergeRequestHeaders(input, init) {
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined,
  );
  const overrides = new Headers(init?.headers ?? {});
  for (const [name, value] of overrides.entries()) headers.set(name, value);
  return headers;
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function writeRequestBody(request, body) {
  if (body === undefined || body === null) {
    request.end();
    return;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    request.end(body);
    return;
  }
  if (body instanceof ArrayBuffer) {
    request.end(Buffer.from(body));
    return;
  }
  if (body instanceof URLSearchParams) {
    request.end(body.toString());
    return;
  }
  request.destroy(new TypeError("Unsupported benchmark HTTP request body."));
}

function isLoopbackHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    hostname.toLocaleLowerCase(),
  );
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function redactUrl(value) {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, "[redacted]");
  }
  return parsed.toString();
}
