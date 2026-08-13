import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startFlowBenchmarkFixture } from "./flow-benchmark-fixture.mjs";

test("serves deterministic legacy, large-menu, grid and counted POST fixtures", async () => {
  const fixture = await startFlowBenchmarkFixture();
  try {
    assert.equal((await fetch(fixture.legacyUrl("test-run"))).status, 200);
    const segmented = await (await fetch(fixture.segmentedUrl)).text();
    assert.match(segmented, /segmented-menu\.html/u);
    const grid = await (await fetch(fixture.gridUrl())).text();
    assert.equal((grid.match(/<tr>/gu) ?? []).length, 21);
    const empty = await (await fetch(fixture.gridUrl(true))).text();
    assert.match(empty, /Nenhum registro encontrado/u);
    const post = await fetch(`${fixture.origin}/flow/submitted.html?nonce=test-run`, {
      method: "POST",
      body: "query=legacy",
    });
    assert.match(await post.text(), /<output id="post-count">1<\/output>/u);
    assert.equal(fixture.getPostCount("test-run"), 1);
  } finally {
    await fixture.close();
  }
});

test("models realistic LegacySite menu state and asynchronous target-frame replacement", async () => {
  const fixture = await startFlowBenchmarkFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const nonce = "legacySite-navigation";
    await page.goto(fixture.legacySiteUrl(nonce), { waitUntil: "load" });
    const contract = fixture.legacySiteContract;
    const menu = page.frame({ name: contract.frames.menu });
    const content = page.frame({ name: contract.frames.content });
    assert.ok(menu);
    assert.ok(content);

    assert.equal(await menu.locator(contract.menu.financeCollapsedRootSelector).isVisible(), true);
    assert.equal(await menu.locator(contract.menu.financeExpandedRootSelector).isVisible(), false);
    assert.equal(await menu.locator(contract.menu.cpxClickSelector).isVisible(), false);
    assert.equal(await menu.locator("body").getAttribute("data-menu-state"), "collapsed");

    await menu.locator(contract.menu.financeClickSelector).click({ noWaitAfter: true });
    await menu.locator(contract.menu.cpxClickSelector).waitFor({ state: "visible" });
    assert.equal(await menu.locator("body").getAttribute("data-menu-state"), "expanded");
    assert.equal(await menu.locator("body").getAttribute("data-menu-transition"), "idle");

    const contentNavigations = [];
    const recordContentNavigation = (frame) => {
      if (frame.name() === contract.frames.content) contentNavigations.push(frame.url());
    };
    page.on("framenavigated", recordContentNavigation);
    await menu.locator(contract.menu.cpxClickSelector).click({ noWaitAfter: true });
    await content.waitForURL(/\/legacySite\/cpx-finance\.html/u);
    page.off("framenavigated", recordContentNavigation);
    assert.equal(await menu.locator("body").getAttribute("data-content-navigation"), "dispatched");
    assert.ok(contentNavigations.some((url) => /\/legacySite\/loading\.html/u.test(url)));
    assert.ok(contentNavigations.some((url) => /\/legacySite\/cpx-finance\.html/u.test(url)));
    assert.equal(await content.locator(contract.content.headerSelector).innerText(), "CPX-Finance");
    for (const id of contract.content.filterIds) {
      assert.equal(await content.locator(`#${id}`).count(), 1);
    }
    assert.equal(fixture.getLegacySiteRequestCount(nonce, "loading"), 1);
    assert.equal(fixture.getLegacySiteRequestCount(nonce, "cpx-finance"), 1);

    await menu.locator(contract.menu.homeSelector).click({ noWaitAfter: true });
    await content.waitForURL(/\/legacySite\/home\.html/u);
    assert.equal(await content.locator("#home-heading").innerText(), "Novidades (Home)");
    assert.equal(fixture.getLegacySiteRequestCount(nonce, "home"), 2);
    const state = await (await fetch(fixture.legacySiteStateUrl(nonce))).json();
    assert.equal(state.nonce, nonce);
    assert.equal(state.requests.loading, 1);
    assert.equal(state.requests["cpx-finance"], 1);
    assert.equal(state.requests.home, 2);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("models legacy focus, selection, keyboard, delayed panel, grid and nested-frame states", async () => {
  const fixture = await startFlowBenchmarkFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const nonce = "legacySite-controls";
    const { menu, content, contract } = await openLegacySiteCpxFixture(page, fixture, nonce);

    await content.locator("#IN2").focus();
    await content.locator("#IN2").fill("empresa-fixture");
    assert.equal(await content.locator("#focus-state").innerText(), "IN2");
    assert.equal(await content.locator("body").getAttribute("data-focused-control"), "IN2");

    await content.locator("#legacy-status").selectOption("pending");
    assert.equal(await content.locator("#selection-state").innerText(), "pending");
    assert.equal(await content.locator("body").getAttribute("data-selected-status"), "pending");

    await content.locator("#IN2").press("Enter");
    assert.equal(await content.locator("#keyboard-state").innerText(), "Enter");

    await content.getByRole("button", { name: "Histórico", exact: true }).click({ noWaitAfter: true });
    await content.locator('body[data-active-view="historico"]').waitFor();
    assert.equal(await content.locator("body").getAttribute("data-pending-view"), "");
    assert.match(await content.locator(contract.content.activePanelSelector).innerText(), /Histórico/u);

    await content.getByRole("button", { name: "Conferências", exact: true }).click({ noWaitAfter: true });
    await content.locator('body[data-active-view="conferencias"]').waitFor();
    assert.equal(await content.locator("body").getAttribute("data-pending-view"), "");
    assert.match(await content.locator(contract.content.activePanelSelector).innerText(), /Conferências/u);

    await content.locator(contract.content.refreshSelector).click({ noWaitAfter: true });
    await content.locator('body[data-grid-state="ready"]').waitFor();
    await content.locator(contract.content.tableSelector).waitFor();
    assert.equal(await content.locator(`${contract.content.tableSelector} tbody tr`).count(), 2);
    assert.equal(await content.locator(contract.content.loadCountSelector).innerText(), "2 lançamentos");

    await content.waitForFunction(() => document.body.dataset.detailState === "ready");
    await content.locator('iframe[name="DetailPane"]').waitFor();
    const detail = content.childFrames().find((frame) => frame.name() === contract.frames.detail);
    assert.ok(detail);
    assert.equal(await detail.locator("#detail-ready").innerText(), "Detalhes carregados.");
    assert.equal(fixture.getLegacySiteRequestCount(nonce, "detail"), 1);

    assert.equal(await menu.locator("body").getAttribute("data-menu-state"), "expanded");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("serves deterministic Windows-1252 legacy text through direct and framed navigation", async () => {
  const fixture = await startFlowBenchmarkFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const nonce = "legacySite-encoding";
    const direct = await fetch(fixture.legacySiteEncodingUrl(nonce));
    assert.match(direct.headers.get("content-type") ?? "", /charset=windows-1252/iu);
    const decoded = new TextDecoder("windows-1252").decode(
      new Uint8Array(await direct.arrayBuffer()),
    );
    assert.match(decoded, /Conferências \| Histórico \| Descrição \| Situação \| Ação/u);

    const page = await browser.newPage();
    await page.goto(fixture.legacySiteUrl(nonce), { waitUntil: "load" });
    const contract = fixture.legacySiteContract;
    const menu = page.frame({ name: contract.frames.menu });
    const content = page.frame({ name: contract.frames.content });
    assert.ok(menu);
    assert.ok(content);
    await menu.locator(contract.menu.financeClickSelector).click({ noWaitAfter: true });
    await menu.locator(contract.menu.encodingSelector).waitFor({ state: "visible" });
    await menu.locator(contract.menu.encodingSelector).click({ noWaitAfter: true });
    await content.waitForURL(/\/legacySite\/encoding\.html/u);
    assert.equal(await content.locator("#encoded-text").innerText(), contract.encoding.expectedText);
    assert.equal(fixture.getLegacySiteRequestCount(nonce, "encoding"), 2);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("controlled POST replaces the target frame document exactly once", async () => {
  const fixture = await startFlowBenchmarkFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(fixture.legacyUrl("browser-post"));
    const content = page.frames().find((frame) => frame.name() === "MenuContent");
    assert.ok(content);
    await content.locator("#query").fill("consulta legacy");
    await content.locator("#confirm-post").click();
    await content.locator("#postback-heading").waitFor();
    assert.equal(await content.locator("#post-count").innerText(), "1");
    assert.equal(fixture.getPostCount("browser-post"), 1);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("real browser reaches every deterministic local flow postcondition", async () => {
  const fixture = await startFlowBenchmarkFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const pass of ["cold", "warm"]) {
      await page.goto(fixture.legacyUrl(`menu-${pass}`), { waitUntil: "load" });
      const menu = page.frames().find((frame) => frame.name() === "Menu");
      const content = page.frames().find((frame) => frame.name() === "MenuContent");
      assert.ok(menu);
      assert.ok(content);
      await menu.locator("#financeiro").click();
      await menu.locator("#cpx-finance").click();
      await menu.locator("#historico").click({ noWaitAfter: true });
      await content.waitForURL(/historico\.html/u);
      assert.equal(await content.locator("h1").innerText(), "Histórico");
    }

    await page.goto(fixture.legacyUrl("form"), { waitUntil: "load" });
    const form = page.frames().find((frame) => frame.name() === "MenuContent");
    assert.ok(form);
    await form.locator("#query").fill("consulta legacy");
    await form.locator("#category").selectOption("recent");
    await form.locator("#query").press("ArrowRight");
    assert.equal(await form.locator("#query").inputValue(), "consulta legacy");
    assert.equal(await form.locator("#category").inputValue(), "recent");

    await page.goto(fixture.segmentedUrl, { waitUntil: "load" });
    const largeMenu = page.frames().find((frame) => frame.name() === "Menu");
    const largeContent = page.frames().find((frame) => frame.name() === "MenuContent");
    assert.ok(largeMenu);
    assert.ok(largeContent);
    assert.ok(await largeMenu.locator("a").count() > 2_500);
    await largeMenu.locator("#financeiro-segmented").click();
    await largeMenu.locator("#cpx-finance-segmented").click({ noWaitAfter: true });
    for (const panel of ["Histórico", "Conferências"]) {
      await largeContent.getByRole("button", { name: panel, exact: true })
        .click({ noWaitAfter: true });
      await largeContent.locator(".tab.is-active", { hasText: panel }).waitFor();
    }

    await page.goto(fixture.gridUrl(true), { waitUntil: "load" });
    assert.equal(await page.locator("#empty-state").innerText(), "Nenhum registro encontrado.");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

async function openLegacySiteCpxFixture(page, fixture, nonce) {
  await page.goto(fixture.legacySiteUrl(nonce), { waitUntil: "load" });
  const contract = fixture.legacySiteContract;
  const menu = page.frame({ name: contract.frames.menu });
  const content = page.frame({ name: contract.frames.content });
  assert.ok(menu);
  assert.ok(content);
  await menu.locator(contract.menu.financeClickSelector).click({ noWaitAfter: true });
  await menu.locator(contract.menu.cpxClickSelector).waitFor({ state: "visible" });
  await menu.locator(contract.menu.cpxClickSelector).click({ noWaitAfter: true });
  await content.waitForURL(/\/legacySite\/cpx-finance\.html/u);
  await content.locator(contract.content.headerSelector).waitFor();
  return { menu, content, contract };
}
