import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";
import { BrowserLegacyAutomationService } from "../../services/browser-legacy-automation-service.js";
import { NodeBrowserDependencyProbe } from "../../services/browser-readiness.js";

const directories: string[] = [];
const drivers: DirectPlaywrightDriver[] = [];

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 150,
      }),
    ),
  );
}, 30_000);

describe("DirectPlaywrightDriver", () => {
  it("returns action state and indexes a named legacy frame natively", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    const frameHtml = encodeURIComponent(`
      <!doctype html>
      <html><body>
        <table role="presentation"><tr><td>Legacy LegacySite menu</td></tr></table>
        <input id="legacy-code" name="legacyCode" value="A-42">
        <button id="legacy-save" onclick="document.body.dataset.saved='yes'">Salvar legado</button>
      </body></html>
    `);
    await page.setContent(`
      <!doctype html>
      <html><body>
        <button id="increment" onclick="
          const status = document.getElementById('status');
          status.textContent = String(Number(status.textContent) + 1);
        ">Incrementar</button>
        <output id="status">0</output>
        <iframe id="legacy" src="data:text/html,${frameHtml}"></iframe>
      </body></html>
    `);
    await page.locator("#legacy").waitFor();
    await driver.resolveFramePath(["legacy"]);
    await page.evaluate(() => {
      console.log("direct-console-info");
      console.error("direct-console-error");
    });
    const debugConsole = await driver.readConsole({ level: "debug" });
    const errorConsole = await driver.readConsole({ level: "error" });
    expect(debugConsole.text).toContain("direct-console-info");
    expect(debugConsole.text).toContain("direct-console-error");
    expect(errorConsole.text).toContain("direct-console-error");
    expect(errorConsole.text).not.toContain("direct-console-info");

    const full = await driver.captureSemanticSnapshot({ forceFull: true });
    expect(full.update.kind).toBe("full");
    const ref = /\[ref=([^\]\s]+)\]/.exec(full.fullContent)?.[1];
    expect(ref).toBeDefined();

    await driver.click({ target: ref! });
    const changed = await driver.captureSemanticSnapshot({
      knownRevision: full.update.revision,
    });
    expect(["delta", "full"]).toContain(changed.update.kind);
    expect(changed.update.revision).toBeGreaterThan(full.update.revision);

    const legacy = new BrowserLegacyAutomationService({ driver });
    const profile = await legacy.profilePage({ tabId: "tab-direct" });
    expect(profile.result.signals.frames).toBeGreaterThanOrEqual(1);
    expect(profile.result.profile).not.toBe("modern");

    const index = await legacy.domIndex({
      tabId: "tab-direct",
      framePath: ["legacy"],
      query: "legacy",
      limit: 20,
    });
    expect(index.result.framePath).toEqual(["legacy"]);
    expect(index.result.items.some((item) => item.id === "legacy-code")).toBe(
      true,
    );
    expect(
      index.result.items.every(
        (item) => item.framePath.join("/") === "legacy",
      ),
    ).toBe(true);
  }, 30_000);

  it("detects zero usable pages and recreates a page in the existing context", async () => {
    const driver = await createDriver();
    expect(driver.hasUsablePage()).toBe(true);

    await driver.currentPage().close();
    expect(driver.isConnected()).toBe(true);
    expect(driver.hasUsablePage()).toBe(false);

    const tabs = await driver.newTab();
    expect(tabs).toHaveLength(1);
    expect(driver.hasUsablePage()).toBe(true);
  }, 30_000);

  it("performs exactly one credential submit and recognizes the authenticated session", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <script>window.submitCount = 0;</script>
        <form id="login" onsubmit="
          event.preventDefault();
          window.submitCount += 1;
          const user = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          if (user === 'reader' && password === 'secret-value') {
            this.remove();
            document.body.dataset.authenticated = 'true';
          } else {
            document.getElementById('error').textContent = 'Usuário ou senha inválidos';
          }
        ">
          <input id="username" autocomplete="username">
          <input id="password" type="password" autocomplete="current-password">
          <button type="submit">Entrar</button>
          <div id="error"></div>
        </form>
      </body></html>
    `);

    await expect(driver.inspectAuthenticationState()).resolves.toEqual({
      state: "login-required",
    });
    await expect(driver.authenticateWithCredential(
      {
        username: Buffer.from("reader", "utf8"),
        password: Buffer.from("secret-value", "utf8"),
      },
      { timeoutMs: 5_000 },
    )).resolves.toEqual({ status: "performed" });
    await expect(page.evaluate<number>("window.submitCount"))
      .resolves.toBe(1);
    await expect(driver.inspectAuthenticationState()).resolves.toEqual({
      state: "authenticated",
    });
    await expect(driver.listNetwork()).resolves.toMatchObject({ text: "" });
    await expect(driver.readConsole()).resolves.toMatchObject({ text: "" });
  }, 30_000);

  it("cleans diagnostic suppression after an ambiguous submit failure", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <form>
          <input autocomplete="username">
          <input type="password">
          <button type="submit" disabled>Entrar</button>
        </form>
      </body></html>
    `);

    await expect(driver.authenticateWithCredential(
      {
        username: Buffer.from("reader", "utf8"),
        password: Buffer.from("secret-value", "utf8"),
      },
      { timeoutMs: 10_000 },
    )).resolves.toEqual({
      status: "failed",
      reason: "submit-outcome-unknown",
    });
    await page.evaluate(() => console.info("diagnostics-restored"));
    await expect(driver.readConsole()).resolves.toMatchObject({
      text: expect.stringContaining("diagnostics-restored"),
    });
  }, 60_000);

  it("returns interaction-required without submitting when an MFA field is present", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <script>window.submitCount = 0;</script>
        <form onsubmit="event.preventDefault(); window.submitCount += 1;">
          <input autocomplete="username">
          <input type="password">
          <input autocomplete="one-time-code">
          <button type="submit">Entrar</button>
        </form>
      </body></html>
    `);

    await expect(driver.inspectAuthenticationState()).resolves.toEqual({
      state: "interaction-required",
      reason: "mfa-or-captcha",
    });
    await expect(driver.authenticateWithCredential(
      {
        username: Buffer.from("reader", "utf8"),
        password: Buffer.from("secret-value", "utf8"),
      },
      { timeoutMs: 5_000 },
    )).resolves.toEqual({
      status: "interaction-required",
      reason: "mfa-or-captcha",
    });
    await expect(page.evaluate<number>("window.submitCount"))
      .resolves.toBe(0);
  }, 30_000);

  it("waits for delayed main-document hydration before reporting a stable page", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <main id="content">loading</main>
        <script>
          setTimeout(() => {
            document.getElementById("content").textContent = "hydrated content";
          }, 250);
        </script>
      </body></html>
    `);

    const stabilized = await driver.stabilizePage({ timeoutMs: 1_500 });

    expect(stabilized.status).toBe("stable");
    await expect(page.locator("#content").innerText()).resolves.toBe("hydrated content");
  }, 30_000);

  it("waits for an explicitly targeted frame to become stable", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`<iframe name="late-frame"></iframe>`);
    const frame = page.frames().find((candidate) => candidate.name() === "late-frame");
    if (!frame) throw new Error("Expected late-frame.");
    await frame.setContent(`
      <!doctype html>
      <html><body>
        <div id="frame-content">loading</div>
        <script>
          setTimeout(() => {
            document.getElementById("frame-content").textContent = "frame hydrated";
          }, 250);
        </script>
      </body></html>
    `);

    const stabilized = await driver.stabilizeFrame("late-frame", { timeoutMs: 1_500 });

    expect(stabilized.status).toBe("stable");
    await expect(frame.locator("#frame-content").innerText()).resolves.toBe("frame hydrated");
  }, 30_000);

  it("recognizes only semantic rel=next as an automatic pagination signal", async () => {
    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body>
        <a href="https://example.test/page/2">Next</a>
      </body></html>
    `);

    await expect(driver.probeExtraction("text")).resolves.not.toHaveProperty("nextUrl");

    await page.setContent(`
      <!doctype html>
      <html><body>
        <a rel="next" href="https://example.test/page/2">Continue</a>
      </body></html>
    `);

    await expect(driver.probeExtraction("text")).resolves.toMatchObject({
      nextUrl: "https://example.test/page/2",
    });
  }, 30_000);
  it("records a persistent-context page through CDP screencast", async () => {
    const ffmpegAvailable = await new NodeBrowserDependencyProbe()
      .isFfmpegAvailable();
    expect(ffmpegAvailable).toBe(true);

    const driver = await createDriver();
    const page = driver.currentPage();
    await page.setContent(`
      <!doctype html>
      <html><body><div id="frame">frame-0</div></body></html>
    `);
    const started = await driver.startVideo({
      filename: "direct-screencast.webm",
      width: 640,
      height: 360,
    });
    for (let index = 1; index <= 5; index += 1) {
      await page.locator("#frame").evaluate(
        `(element) => { element.textContent = "frame-${index}"; element.style.marginLeft = "${index * 10}px"; }`,
      );
      await page.waitForTimeout(80);
    }
    const artifact = await driver.stopVideo();

    expect(artifact.kind).toBe("video");
    expect(artifact.path).toBe(started.path);
    expect(artifact.sizeBytes).toBeGreaterThan(0);
  }, 30_000);
});

async function createDriver(): Promise<DirectPlaywrightDriver> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "direct-playwright-driver-"),
  );
  directories.push(directory);
  const driver = new DirectPlaywrightDriver(makeConfig(directory));
  drivers.push(driver);
  await driver.connect();
  return driver;
}

function makeConfig(directory: string): BrowserWorkerConfig {
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
    runtimeDirectory: directory,
    privateDirectory: path.join(directory, "private"),
    primaryPrivateSiteUrl: new URL("https://dev-private.example.test/app"),
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
