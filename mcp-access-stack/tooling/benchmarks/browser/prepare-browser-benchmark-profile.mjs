import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.root ?? process.cwd());
  const profileDirectory = path.resolve(required(options.profile, "profile"));
  const url = new URL(required(options.url, "url"));
  if (url.protocol !== "https:" || url.hostname !== "dev-private.example.test") {
    throw new Error("Profile preparation is restricted to the allowed LegacySite Dev HTTPS domain.");
  }
  if (isPersonalBrowserProfile(profileDirectory)) {
    throw new Error("A personal Chrome or Edge profile cannot be used for benchmarks.");
  }
  const playwrightPath = path.join(root, "node_modules", "playwright", "index.mjs");
  const playwrightFile = await stat(playwrightPath).catch(() => undefined);
  if (!playwrightFile?.isFile()) {
    throw new Error(`Playwright is not installed at ${root}. Run npm ci first.`);
  }
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    ...(options.channel ? { channel: options.channel } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await prompt.question(
      "Autentique manualmente no perfil dedicado. Pressione Enter somente quando a tela Dev estiver pronta...",
    );
  } finally {
    prompt.close();
    await context.close();
  }
  process.stdout.write(`Perfil dedicado preservado em ${profileDirectory}\n`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    const key = match?.[1] ?? argument.replace(/^--/u, "");
    const value = match?.[2] ?? argv[index + 1];
    if (!match) index += 1;
    switch (key) {
      case "root": values.root = value; break;
      case "profile": values.profile = value; break;
      case "url": values.url = value; break;
      case "channel": values.channel = value; break;
      default: throw new Error(`Unknown argument: --${key}`);
    }
  }
  return values;
}

function isPersonalBrowserProfile(value) {
  const normalized = value.replaceAll("/", "\\").toLocaleLowerCase("en-US");
  return /\\google\\chrome\\user data(?:\\|$)/u.test(normalized) ||
    /\\microsoft\\edge\\user data(?:\\|$)/u.test(normalized);
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
