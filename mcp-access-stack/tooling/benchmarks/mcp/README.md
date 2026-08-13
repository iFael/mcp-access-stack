# MCP performance benchmarks

This suite measures complete MCP calls without writing arguments, tokens, field values or file contents to reports.

## Method

- deterministic randomized scenario order;
- five warm-up calls by default;
- thirty warm samples and three cold samples;
- concurrency levels 1 and 4;
- raw NDJSON plus JSON, CSV and Markdown summaries;
- p50, p90, p95, p99, mean, standard deviation, coefficient of variation and error rate;
- p95 is the primary comparison metric.

## Configure

Copy `tooling/benchmarks/mcp/config.example.json` to a private runtime location, replace workspace and browser fixture identifiers, and enable only scenarios that are safe for the target environment. Keep tokens in environment variables.

```powershell
$env:MCP_BENCH_URL = "http://127.0.0.1:3300/mcp"
$env:MCP_BENCH_TOKEN = "..."
npm run bench:mcp -- --config .runtime-private/benchmarks/mcp-config.json
```

Multiple routes can be compared with `MCP_BENCH_ROUTES_JSON`. Each route object accepts `name`, `url`, `token`, and optional non-sensitive `headers`.

## Safety

The example keeps write and state-changing browser scenarios disabled. Use deterministic fixture workspaces and an MCP-owned browser tab. Do not benchmark destructive commands or personal tabs. `browser_wait` reports total duration; compare its overhead by subtracting the requested delay.

Each run is written below `runtime/benchmarks/mcp/<runId>/`. The result directory should remain untracked.
