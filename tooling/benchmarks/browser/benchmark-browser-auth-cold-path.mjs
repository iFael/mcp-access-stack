import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_ROOT = path.join("runtime", "benchmarks", "browser", "auth-cold");
const DEFAULT_SAMPLES = 10;
const DEFAULT_WARMUPS = 2;
const BENCHMARK_USERNAME = "benchmark-user";
const BENCHMARK_PASSWORD = "benchmark-password-not-a-real-secret";

export function distribution(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  }
  const percentile = (ratio) => sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  )];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted.at(-1)),
    meanMs: round(mean),
  };
}

export function summarizeScenario(samples, expectedStatuses) {
  const measured = samples.filter((sample) => sample.phase === "measured");
  const expected = new Set(expectedStatuses);
  const successes = measured.filter((sample) => expected.has(sample.status));
  const interactions = measured.filter((sample) => sample.status === "interaction-required");
  return {
    expectedStatuses: [...expected],
    latencyMs: distribution(measured.map((sample) => sample.durationMs)),
    successRate: measured.length === 0 ? 0 : round(successes.length / measured.length, 6),
    interactionRate: measured.length === 0 ? 0 : round(interactions.length / measured.length, 6),
    statuses: countBy(measured, (sample) => sample.status),
    reasons: countBy(measured.filter((sample) => sample.reason), (sample) => sample.reason),
    samples: measured,
  };
}

export function buildColdPathReport({ runId, samples, warmups, scenarios }) {
  const report = {
    schemaVersion: 1,
    benchmark: "browser-auth-cold-path",
    classification: "observational-only",
    hotPathGateImpact: "excluded",
    runId,
    generatedAt: new Date().toISOString(),
    configuration: {
      samples,
      warmups,
      realCredentialUsed: false,
      realCredentialProvisioned: false,
      realLegacySiteAccessed: false,
    },
    scenarios,
  };
  const scenarioValues = Object.values(scenarios);
  report.summary = {
    scenarioCount: scenarioValues.length,
    overallSuccessRate: round(
      scenarioValues.reduce((sum, scenario) => sum + scenario.successRate, 0) /
        Math.max(1, scenarioValues.length),
      6,
    ),
    interactionRate: round(
      scenarioValues.reduce((sum, scenario) => sum + scenario.interactionRate, 0) /
        Math.max(1, scenarioValues.length),
      6,
    ),
    loginPerformedP50Ms: scenarios.loginPerformed?.latencyMs?.p50Ms ?? null,
    loginPerformedP95Ms: scenarios.loginPerformed?.latencyMs?.p95Ms ?? null,
    brokerStartupP50Ms: scenarios.brokerStartupUnavailable?.latencyMs?.p50Ms ?? null,
    brokerStartupP95Ms: scenarios.brokerStartupUnavailable?.latencyMs?.p95Ms ?? null,
  };
  report.passed = scenarioValues.every((scenario) => scenario.successRate === 1);
  assertReportContainsNoBenchmarkSecrets(report);
  return report;
}

export async function runBrowserAuthColdPathBenchmark(options = {}) {
  const samples = positiveInteger(options.samples ?? DEFAULT_SAMPLES, "samples");
  const warmups = nonnegativeInteger(options.warmups ?? DEFAULT_WARMUPS, "warmups");
  const brokerPath = path.resolve(requiredString(options.brokerPath, "brokerPath"));
  const candidateRoot = path.resolve(options.candidateRoot ?? process.cwd());
  const runId = options.runId ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDirectory = path.resolve(candidateRoot, OUTPUT_ROOT, runId);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-auth-cold-benchmark-"));
  const privateDirectory = path.join(temporaryDirectory, "private");
  await mkdir(privateDirectory, { recursive: true });

  const {
    BrowserSiteGrantRegistry,
  } = await import("../../../services/browser-worker/dist/domain/browser-site-grant-registry.js");
  const {
    DirectPlaywrightDriver,
  } = await import("../../../services/browser-worker/dist/drivers/direct/direct-playwright-driver.js");
  const {
    BrowserSiteAuthenticationService,
  } = await import("../../../services/browser-worker/dist/services/browser-site-authentication-service.js");
  const {
    CredentialSecret,
    WindowsCredentialBrokerClient,
  } = await import("../../../services/browser-worker/dist/services/windows-credential-broker-client.js");

  const policy = {
    siteId: "private-site",
    entryUrl: "https://dev-legacySite.example/LegacySite.asp",
    allowedOrigins: ["https://dev-legacySite.example"],
    deniedOrigins: ["https://legacySite.example"],
    accessMode: "business-read-only",
    loginStrategy: "credential-broker",
    credentialAccountId: "benchmark",
  };
  const now = new Date();
  const task = {
    taskId: "benchmark-task",
    ownerScopeHash: "benchmark-owner",
    state: "active",
    tabIds: [],
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    lifecycleVersion: 1,
  };

  const driver = new DirectPlaywrightDriver(makeDriverConfig(temporaryDirectory));
  const raw = {
    confirmation: [],
    brokerStartupUnavailable: [],
    sessionReused: [],
    loginPerformed: [],
    interactionRequired: [],
    sanitizedFailure: [],
  };

  try {
    await driver.connect();
    const page = driver.currentPage();
    const brokerClient = new WindowsCredentialBrokerClient({
      executablePath: brokerPath,
      privateDirectory,
      timeoutMs: 10_000,
    });

    for (let index = 0; index < warmups + samples; index += 1) {
      const phase = index < warmups ? "warmup" : "measured";
      const sample = Math.max(0, index - warmups);

      raw.confirmation.push(await measure(phase, sample, async () => {
        const registry = new BrowserSiteGrantRegistry();
        const pending = registry.createConfirmation(task, policy, "benchmark-confirmation");
        registry.confirm(pending.confirmationId, task, policy, "benchmark-confirmation");
        return { status: "granted" };
      }));

      raw.brokerStartupUnavailable.push(await measure(phase, sample, async () => {
        const result = await brokerClient.read({
          siteId: policy.siteId,
          accountId: "benchmark-nonexistent",
        });
        return { status: result.status };
      }));

      await page.setContent(authenticatedFixture());
      let warmBrokerReads = 0;
      const warmService = new BrowserSiteAuthenticationService(
        driver,
        { read: async () => {
          warmBrokerReads += 1;
          return { status: "broker-unavailable" };
        } },
        { loginTimeoutMs: 5_000, invalidCredentialBackoffMs: 60_000 },
      );
      raw.sessionReused.push(await measure(phase, sample, async () => {
        const result = await warmService.authenticate(policy);
        if (warmBrokerReads !== 0) throw new Error("Session reuse accessed the broker.");
        return result;
      }));

      await page.setContent(loginFixture());
      let loginBrokerReads = 0;
      const loginService = new BrowserSiteAuthenticationService(
        driver,
        { read: async () => {
          loginBrokerReads += 1;
          return {
            status: "success",
            secret: new CredentialSecret(
              Buffer.from(BENCHMARK_USERNAME, "utf8"),
              Buffer.from(BENCHMARK_PASSWORD, "utf8"),
            ),
          };
        } },
        { loginTimeoutMs: 5_000, invalidCredentialBackoffMs: 60_000 },
      );
      raw.loginPerformed.push(await measure(phase, sample, async () => {
        const result = await loginService.authenticate(policy);
        const submitCount = await page.evaluate("window.submitCount");
        if (loginBrokerReads !== 1 || submitCount !== 1) {
          throw new Error("Login cold path did not perform exactly one broker read and submit.");
        }
        return result;
      }));

      await page.setContent(interactionFixture());
      let interactionBrokerReads = 0;
      const interactionService = new BrowserSiteAuthenticationService(
        driver,
        { read: async () => {
          interactionBrokerReads += 1;
          return { status: "broker-unavailable" };
        } },
        { loginTimeoutMs: 5_000, invalidCredentialBackoffMs: 60_000 },
      );
      raw.interactionRequired.push(await measure(phase, sample, async () => {
        const result = await interactionService.authenticate(policy);
        if (interactionBrokerReads !== 0) {
          throw new Error("MFA/CAPTCHA cold path accessed the broker.");
        }
        return result;
      }));

      await page.setContent(loginFixture());
      const failureService = new BrowserSiteAuthenticationService(
        driver,
        { read: async () => { throw new Error("benchmark internal broker failure"); } },
        { loginTimeoutMs: 5_000, invalidCredentialBackoffMs: 60_000 },
      );
      raw.sanitizedFailure.push(await measure(phase, sample, async () =>
        failureService.authenticate(policy)));
    }

    const scenarios = {
      confirmation: summarizeScenario(raw.confirmation, ["granted"]),
      brokerStartupUnavailable: summarizeScenario(
        raw.brokerStartupUnavailable,
        ["unavailable"],
      ),
      sessionReused: summarizeScenario(raw.sessionReused, ["session-reused"]),
      loginPerformed: summarizeScenario(raw.loginPerformed, ["performed"]),
      interactionRequired: summarizeScenario(
        raw.interactionRequired,
        ["interaction-required"],
      ),
      sanitizedFailure: summarizeScenario(raw.sanitizedFailure, ["failed"]),
    };
    const report = buildColdPathReport({ runId, samples, warmups, scenarios });
    await mkdir(outputDirectory, { recursive: true });
    const jsonPath = path.join(outputDirectory, "report.json");
    const markdownPath = path.join(outputDirectory, "report.md");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, renderMarkdown(report), "utf8");
    return { report, outputDirectory, jsonPath, markdownPath };
  } finally {
    await driver.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

async function measure(phase, sample, operation) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    return {
      phase,
      sample,
      durationMs: round(performance.now() - startedAt),
      status: String(result.status),
      ...(result.reason === undefined ? {} : { reason: String(result.reason) }),
    };
  } catch (error) {
    return {
      phase,
      sample,
      durationMs: round(performance.now() - startedAt),
      status: "benchmark-error",
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown-error",
    };
  }
}

function makeDriverConfig(directory) {
  return {
    host: "127.0.0.1",
    port: 3350,
    token: "x".repeat(32),
    mode: "interactive",
    profileMode: "persistent",
    browserChannel: "chromium",
    headless: true,
    userDataDirectory: path.join(directory, "private", "chrome-profile"),
    maxPayloadBytes: 4 * 1024 * 1024,
    maxOwnedTabs: 8,
    maxConcurrentTabs: 4,
    runtimeDirectory: path.join(directory, "runtime"),
    privateDirectory: path.join(directory, "private"),
    legacySiteUrl: new URL("https://dev-legacySite.example/LegacySite.asp"),
    privateSitePolicies: [],
    connectTimeoutMs: 30_000,
    operationTimeoutMs: 30_000,
    actionTimeoutMs: 5_000,
    navigationTimeoutMs: 10_000,
    outputMaxBytes: 64 * 1024 * 1024,
    diagnosticTimeoutMs: 30_000,
    diagnosticRetentionMs: 60_000,
    diagnosticMaxArtifacts: 20,
    diagnosticMaxEntries: 100,
  };
}

function authenticatedFixture() {
  return "<!doctype html><title>Authenticated</title><main data-authenticated='true'>Benchmark session</main>";
}

function loginFixture() {
  return `<!doctype html><title>Login</title>
<form id="login"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Entrar</button></form>
<script>
window.submitCount = 0;
document.getElementById('login').addEventListener('submit', (event) => {
  event.preventDefault();
  window.submitCount += 1;
  document.body.innerHTML = '<main data-authenticated="true">Authenticated benchmark</main>';
});
</script>`;
}

function interactionFixture() {
  return "<!doctype html><title>MFA</title><input type='password'><input autocomplete='one-time-code' name='otp'>";
}

function renderMarkdown(report) {
  const lines = [
    "# Browser authentication cold-path benchmark",
    "",
    `- Run: ${report.runId}`,
    `- Classification: ${report.classification}`,
    `- Hot-path gate impact: ${report.hotPathGateImpact}`,
    `- Passed: ${report.passed}`,
    `- Overall success rate: ${report.summary.overallSuccessRate}`,
    `- Interaction rate: ${report.summary.interactionRate}`,
    "",
    "| Scenario | p50 ms | p95 ms | success | interaction |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const [name, scenario] of Object.entries(report.scenarios)) {
    lines.push(
      `| ${name} | ${scenario.latencyMs.p50Ms ?? "n/a"} | ${scenario.latencyMs.p95Ms ?? "n/a"} | ${scenario.successRate} | ${scenario.interactionRate} |`,
    );
  }
  lines.push("", "No real credential or real LegacySite environment was used.", "");
  return lines.join("\n");
}

function assertReportContainsNoBenchmarkSecrets(report) {
  const serialized = JSON.stringify(report);
  for (const forbidden of [BENCHMARK_USERNAME, BENCHMARK_PASSWORD]) {
    if (serialized.includes(forbidden)) {
      throw new Error("Cold-path benchmark report contains credential fixture data.");
    }
  }
}

function countBy(values, keyOf) {
  const result = {};
  for (const value of values) {
    const key = String(keyOf(value));
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required ${name}.`);
  }
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${name} must be an integer between 1 and 100.`);
  }
  return parsed;
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 20) {
    throw new Error(`${name} must be an integer between 0 and 20.`);
  }
  return parsed;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${name}.`);
    if (name === "broker-path") options.brokerPath = value;
    else if (name === "candidate-root") options.candidateRoot = value;
    else if (name === "samples") options.samples = Number(value);
    else if (name === "warmups") options.warmups = Number(value);
    else if (name === "run-id") options.runId = value;
    else throw new Error(`Unknown argument: --${name}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runBrowserAuthColdPathBenchmark(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    passed: result.report.passed,
    outputDirectory: result.outputDirectory,
    summary: result.report.summary,
  }, null, 2)}\n`);
  if (!result.report.passed) process.exitCode = 1;
}
