// Real-Chromium smoke for the personal Chrome extension: loads the generated
// extension into a throwaway Playwright Chromium profile (never a personal
// profile), serves nested cross-site frames from loopback under *.test names,
// and drives legacy frame mutations plus plain ref actions through the bridge.
// Run: npm run smoke:browser:personal-frames
// PERSONAL_SMOKE_CHROMIUM overrides the Chromium executable when needed.
// PERSONAL_SMOKE_ROBUSTNESS_ONLY=1 runs the focused editor/scroll regression.
// PERSONAL_SMOKE_CDP_RECOVERY_ONLY=1 injects lost acknowledgements in an isolated profile.
// PERSONAL_SMOKE_FRAME_RECOVERY_ONLY=1 focuses on direct and nested frame input recovery.
// PERSONAL_SMOKE_FOREGROUND_ONLY=1 checks explicit tab selection and exact redirected URLs.
// PERSONAL_SMOKE_BACKGROUND_CAPTURE_ONLY=1 checks exact screenshot identity without selecting the target.
// PERSONAL_SMOKE_NATIVE_BACKGROUND=1 retains Chrome's normal background throttling for that test.
// PERSONAL_SMOKE_RICH_FRAME_ONLY=1 checks editable and protected rich text in scriptable frames.
// PERSONAL_SMOKE_REAL_EDITORS_ONLY=1 checks installed real editor fixtures (isolated lockfile required).
// PERSONAL_SMOKE_PERFORMANCE_ONLY=1 measures paired verified actions and native bridge telemetry.
// PERSONAL_SMOKE_OOPIF_FOCUS_ONLY=1 exercises independent nested navigation and focus samples.
// PERSONAL_SMOKE_HEADFUL=1 uses a real window (e.g. under xvfb-run), which
// shows Chrome's debugging infobar and the OS drag loop like a personal Chrome.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PersonalBrowserBridge } from "../../../services/mcp-gateway/src/companion/personal-browser-bridge.js";
import { createEditorFixture, verifyRealEditors } from "./editor-fixtures/fixture.js";

interface LegacyFixtureRouter {
  handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL): boolean;
  indexUrl(origin: string, nonce: string): string;
}
const fixtureModulePath = "../../benchmarks/browser/legacy-private-site-fixture.mjs";

function richEditorFixture(): string {
  return `<!doctype html><title>Rich text fixture</title>
    <style>[contenteditable="true"]{display:block;width:400px;height:50px;border:1px solid;margin:8px}</style>
    <div id="plain" contenteditable="true" role="textbox" aria-label="Plain rich editor">original</div>
    <div id="protected" contenteditable="true" role="textbox" aria-label="Token editor">prefix <span contenteditable="false" id="token">TOKEN</span> suffix</div>
    <div id="readonly" contenteditable="true" role="textbox" aria-readonly="true" aria-label="Read only editor">locked</div>
    <div id="late-token" contenteditable="true" role="textbox" aria-label="Token on focus" onfocus="if(!this.firstElementChild){const token=document.createElement('span');token.contentEditable='false';token.textContent='TOKEN';this.append(token)}">prefix </div>
    <div id="late-readonly" contenteditable="true" role="textbox" aria-label="Read only on focus" onfocus="this.setAttribute('aria-readonly','true')">locked</div>
    <input id="decoy" value="unchanged">`;
}
const submissions: string[] = [];
const listHits: string[] = [];
const consultationPosts: string[] = [];
const pages: Record<string, (url: URL, port: number) => string> = {
  "recovery-site.test/": () => `<!doctype html><title>CDP recovery fixture</title>
    <body style="margin:0;height:300vh"><div style="position:fixed;top:20px;left:20px">
      <button id="increase">Increase</button><p id="clicks">Count 0</p><p id="wheels">0</p>
      <a href="/runs">Run history</a><input aria-label="Key entry" id="key-entry"><p id="key-count">0</p><p id="insert-count">0</p>
    </div><script>
      let insertCount = 0;
      document.getElementById("key-entry").addEventListener("input", event => {
        if (event.inputType === "insertText") document.getElementById("insert-count").textContent = String(++insertCount);
      });
      let keyCount = 0;
      document.getElementById("key-entry").addEventListener("keydown", () => {
        document.getElementById("key-count").textContent = String(++keyCount);
      });
      let clicks = 0, wheels = 0;
      document.getElementById("increase").addEventListener("click", () => {
        document.getElementById("clicks").textContent = "Count " + (++clicks);
      });
      window.addEventListener("wheel", () => {
        document.getElementById("wheels").textContent = String(++wheels);
      }, {passive:true});
    </script>`,
  "capture-site.test/": url => `<!doctype html><title>Capture ${url.searchParams.has("other") ? "B" : "A"}</title>
    <body style="margin:0;height:1800px;background:${url.searchParams.has("other") ? "#184a90" : "#b83224"}">
      <div style="width:240px;height:160px;background:#eee">Capture ${url.searchParams.has("other") ? "B" : "A"}</div>
      <div style="position:absolute;top:1500px;width:200px;height:100px;background:#222;color:#fff">Below viewport</div>
    </body>`,
  "recovery-site.test/runs": () => "<!doctype html><title>Run history</title><p>Run history destination</p>",
  "frame-recovery-site.test/": (url, port) => `<!doctype html><title>Frame recovery</title>
    <iframe name="content" src="http://${url.searchParams.has("nested") ? "frame-recovery-mid.test" : "recovery-site.test"}:${port}/"
      style="width:640px;height:480px;border:0"></iframe>`,
  "frame-recovery-mid.test/": (_url, port) => `<!doctype html><title>Nested frame recovery</title>
    <iframe name="leaf" src="http://recovery-site.test:${port}/" style="width:500px;height:400px;border:0"></iframe>`,
  "rich-editor-site.test/": (url, port) => `<!doctype html><title>Rich editor host</title>
    <iframe name="editor" src="http://${url.searchParams.has("nested") ? "rich-editor-mid.test" : url.searchParams.has("same") ? "rich-editor-site.test" : "rich-editor-frame.test"}:${port}/${url.searchParams.has("nested") ? "" : "rich"}"
      style="width:640px;height:480px;border:0"></iframe>`,
  "rich-editor-mid.test/": (_url, port) => `<!doctype html><title>Rich editor container</title>
    <iframe name="leaf" src="http://rich-editor-frame.test:${port}/rich" style="width:500px;height:400px;border:0"></iframe>`,
  "rich-editor-site.test/rich": () => richEditorFixture(),
  "rich-editor-frame.test/rich": () => richEditorFixture(),
  "editor-site.test/": () => `<!doctype html><title>Editor geometry fixture</title>
    <body style="margin:0;width:300vw;height:100vh">
      <div class="monaco-editor" style="position:fixed;left:75vw;top:80px;width:160vw;height:80px;background:#ddd;overflow:hidden">
        <textarea id="expression" aria-label="Expression" style="position:absolute;left:1px;top:1px;width:1px;height:1px;padding:0;border:0"></textarea>
        <span id="visual" style="position:absolute;inset:0">Rendered expression</span>
      </div>
      <div id="overlay" style="display:none;position:fixed;inset:0;z-index:99;background:#eee"></div>
      <p id="count">0</p>
      <script>
        document.getElementById("visual").addEventListener("click", () => {
          document.getElementById("expression").focus({preventScroll:true});
          const count = document.getElementById("count");
          count.textContent = String(Number(count.textContent) + 1);
        });
      </script>`,
  "parent-site.test/": (_url, port) => `<!doctype html><title>Parent</title>
    <body style="margin:0"><div style="height:900px">Top content</div>
    <iframe name="a" src="http://mid-site.test:${port}/mid"
      style="position:absolute;left:30px;top:60px;width:640px;height:480px;border:3px solid #333;padding:7px"></iframe>`,
  "mid-site.test/mid": (_url, port) => `<!doctype html><title>Mid</title>
    <body style="margin:5px"><p style="height:90px">Menu do sistema</p>
    <iframe name="b" src="http://leaf-site.test:${port}/form" style="width:520px;height:330px;border:1px solid"></iframe>`,
  "leaf-site.test/form": () => `<!doctype html><title>Form</title>
    <body><form action="/done" method="get">
      <p style="height:150px">Cadastro</p>
      <label>Nome <input name="nome" value="antigo"></label><br>
      <label>UF <select name="uf"><option value="">Escolha</option><option value="sp">São Paulo</option>
        <option value="rj" disabled>Rio</option><option value="mg">Minas</option></select></label><br>
      <button>Salvar</button>
    </form>`,
  "leaf-site.test/done": (url) => {
    submissions.push(url.search);
    return `<!doctype html><title>Done</title><body>
      <p id="ok">Salvo ${url.searchParams.get("nome")} ${url.searchParams.get("uf")}</p>
      <input id="busca" onkeydown="if(event.key==='Enter'){document.getElementById('ok').textContent='Enter recebido: '+this.value}">
      <script>
        window.__focusTrace = [];
        for (const type of ["pointerdown", "pointerup", "focusin", "focusout"]) {
          document.addEventListener(type, event => {
            if (window.__focusTrace.length < 20) window.__focusTrace.push({
              type, id: event.target.id || "", tag: event.target.tagName, trusted: event.isTrusted,
              x: event.clientX, y: event.clientY
            });
          }, true);
        }
      </script>`;
  },
  "menu-site.test/": (_url, port) => `<html><head><title>Legacy</title></head>
    <frameset cols="220,*"><frame name="menu" src="http://menu-site.test:${port}/menu">
    <frame name="main" src="http://content-site.test:${port}/home"></frameset></html>`,
  "menu-site.test/menu": (_url, port) => `<!doctype html><title>Menu</title><body>
    <table><tr><td onclick="document.getElementById('sub').style.display='block'">Cadastros</td></tr></table>
    <div id="sub" style="display:none"><a href="http://content-site.test:${port}/clientes" target="main">Clientes</a></div>
    <a href="#" onclick="document.getElementById('log').textContent='apagado';return false">Excluir registros</a>
    <p id="log">intacto</p>`,
  "content-site.test/home": () => `<!doctype html><title>Home</title><h1 id="title">Início</h1>`,
  "content-site.test/clientes": () => `<!doctype html><title>Clientes</title><h1 id="title">Clientes</h1>`,
  "list-site.test/list": (url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    listHits.push(url.search);
    return `<!doctype html><title>Lista ${page}</title>
      ${page < 3 ? `<link rel="next" href="/list?page=${page + 1}">` : ""}
      <body><p>Item ${page}</p><a href="/list?page=99">Próxima</a>`;
  },
  "list-site.test/cross": (_url, port) => `<!doctype html><title>Cross</title><body>
    <p>Cruzado</p><a rel="next" href="http://other-site.test:${port}/list?page=1">Seguinte</a>`,
  "upload-site.test/": () => `<!doctype html><title>Upload</title><body>
    <div id="zone" role="button" aria-label="Soltar arquivos" style="width:320px;height:120px;border:2px dashed">Arraste aqui</div>
    <label>Arquivo <input type="file" id="arquivo"></label>
    <button id="reler">Reler arquivos</button>
    <p id="out">vazio</p><p id="again">nada</p><p id="kind">-</p>
    <script>
      const zone = document.getElementById("zone");
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", async (event) => {
        event.preventDefault();
        globalThis.dropped = event.dataTransfer.files[0];
        document.getElementById("kind").textContent = "tipo=" + dropped.type + " bytes=" + dropped.size;
        document.getElementById("out").textContent = "drop:" + dropped.name + ":" + await dropped.text();
      });
      document.getElementById("reler").addEventListener("click", async () => {
        const read = async (file) => file ? await file.text().catch((error) => "falhou-" + error.name) : "sem-arquivo";
        document.getElementById("again").textContent =
          "drop=" + await read(globalThis.dropped) + " input=" + await read(document.getElementById("arquivo").files[0]);
      });
    </script>`,
  "log-site.test/one": () => `<!doctype html><title>Um</title><body>Um
    <script>console.error("falha na primeira página"); console.log("primeira pronta");</script>`,
  "log-site.test/two": () => `<!doctype html><title>Dois</title><body>Dois
    <script>console.warn("aviso na segunda página");</script>`,
  "dnd-site.test/": () => `<!doctype html><title>Quadro</title><body>
    <div draggable="true" id="card" role="button" aria-label="Cartão A" style="width:120px;height:40px;background:#ddd">Cartão A</div>
    <div id="done" role="button" aria-label="Coluna Concluído" style="margin-top:120px;width:240px;height:120px;border:1px solid">Concluído</div>
    <p id="status">pendente</p><p id="drop-count">0</p>
    <div id="knob" role="slider" aria-label="Alça" aria-valuenow="0" style="position:absolute;left:300px;top:20px;width:30px;height:30px;background:#88f"></div>
    <p id="pointer">parado</p><p id="release-count">0</p>
    <script>
      let dragging = false, drops = 0, releases = 0;
      document.getElementById("knob").addEventListener("mousedown", () => { dragging = true; });
      document.addEventListener("mouseup", (event) => {
        if (!dragging) return;
        dragging = false;
        document.getElementById("release-count").textContent = String(++releases);
        const zone = document.getElementById("done").getBoundingClientRect();
        const inside = event.clientX >= zone.left && event.clientX <= zone.right && event.clientY >= zone.top && event.clientY <= zone.bottom;
        document.getElementById("pointer").textContent = inside ? "solto na coluna" : "fora";
      });
      document.getElementById("card").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "card"));
      const done = document.getElementById("done");
      done.addEventListener("dragover", (event) => event.preventDefault());
      done.addEventListener("drop", (event) => {
        event.preventDefault();
        document.getElementById("drop-count").textContent = String(++drops);
        document.getElementById("status").textContent = "movido:" + event.dataTransfer.getData("text/plain");
      });
    </script>`,
  "type-site.test/": () => `<!doctype html><title>Digitação</title><body>
    <input id="campo" aria-label="Campo internacional">
    <p id="teclas"></p><p id="ime"></p><p id="valor"></p>
    <script>
      const field = document.getElementById("campo");
      field.addEventListener("input", () => { document.getElementById("valor").textContent = "valor=" + field.value; });
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Process") document.getElementById("teclas").textContent += event.key + "·";
      });
      field.addEventListener("compositionend", (event) => {
        document.getElementById("ime").textContent += "[" + event.data + "]";
      });
    </script>`,
  "pixel-site.test/": () => `<!doctype html><title>Fractional frame</title><body style="margin:0">
    <iframe name="fractional" src="/child" style="display:block;width:300.6px;height:400.6px;border:0"></iframe>`,
  "pixel-site.test/child": () => `<!doctype html><title>Menu</title><body style="margin:0">
    <input id="search" placeholder="Buscar menu" style="width:150px;height:30px">
    <button id="danger" onclick="document.body.dataset.deleted='yes'">Excluir registros</button>`,
  "consult-site.test/MisterT.asp": (url) => url.searchParams.get("R") === "42"
    ? `<!doctype html><title>Resultados</title><p id="result">Consulta concluída</p>`
    : `<!doctype html><title>Itens do Estoque</title><form method="post" action="/MisterT.asp?CTRL=fixture&R=42">
      <label>Descrição <input name="IN1"></label>
      <input type="submit" name="IN2" value="Pesquisar" onclick="ISP_Submit_OnClick(this);">
      <input type="submit" name="IN3" value="Salvar" onclick="ISP_Submit_OnClick(this);">
      </form><script>function ISP_Submit_OnClick(control) {}</script>`,
  "share-site.test/": (_url, port) => `<!doctype html><title>Minha aba</title><body>
    <button onclick="document.getElementById('estado').textContent='clicado pelo MCP'">Marcar</button>
    <p id="estado">intocado</p><a href="http://plain-site.test:${port}/?via=plano">Sair do plano</a>`,
  "rec-site.test/": () => `<!doctype html><title>Gravação</title>
    <body style="margin:0;height:100vh;background:#ffffff">
    <button onclick="document.body.style.background='#00c000'">Pintar</button>
    <button onclick="document.body.style.background='#ffffff'">Limpar</button>`,
  "performance-site.test/": () => `<!doctype html><title>Personal performance</title><body>
    <button id="run">Mostrar resultado</button><p id="result">pending</p><p id="clicks">0</p>
    <script>
      document.getElementById("run").onclick = () => {
        const count = Number(document.getElementById("clicks").textContent) + 1;
        document.getElementById("clicks").textContent = String(count);
        setTimeout(() => { document.getElementById("result").textContent = "finished [" + count + "]"; }, 450);
      };
    </script>`,
  "quality-site.test/": () => `<!doctype html><title>Interaction quality</title><body>
    <button id="run">Mostrar resultado</button><button id="noop">Mostrar nada</button>
    <input id="entry" aria-label="Entry" value="abc def">
    <div id="rich" contenteditable="true" role="textbox" aria-label="Rich">abc def</div>
    <input id="focus-trap" aria-label="Guarded input" value="old">
    <input id="decoy" aria-label="Decoy" value="unchanged">
    <p id="result">pending</p><p id="clicks">0</p>
    <a id="help" href="/help">Help</a>
    <script>
      const trap = document.getElementById("focus-trap");
      let pointerFocused = false;
      trap.addEventListener("pointerdown", () => { pointerFocused = true; });
      trap.addEventListener("focus", () => {
        if (!pointerFocused) document.getElementById("decoy").focus();
      });
      document.getElementById("run").onclick = () => {
        document.getElementById("clicks").textContent = String(Number(document.getElementById("clicks").textContent) + 1);
        setTimeout(() => { document.getElementById("result").textContent = "finished"; }, 450);
      };
      document.getElementById("noop").onclick = () => {
        document.getElementById("clicks").textContent = String(Number(document.getElementById("clicks").textContent) + 1);
      };
    </script>`,
  "quality-site.test/help": () => "<!doctype html><title>Help</title><script src='/slow-help.js'></script><p>Help destination</p>",
  "plain-site.test/": (url) => {
    return `<!doctype html><title>Plain</title><body>
    <button onclick="document.getElementById('out').textContent='Mostrado'">Mostrar detalhes</button>
    <p id="out">Oculto</p>`;
  },
};

function report(label: string, value: unknown): void {
  console.log(`\n== ${label}\n${JSON.stringify(value, null, 1).slice(0, 2500)}`);
}

// The extension's tabs.get and Playwright's page events are independent.
async function waitForFixturePage(context: BrowserContext, url: string): Promise<Page> {
  const deadline = Date.now() + 15_000;
  do {
    const page = context.pages().find((candidate) => candidate.url() === url);
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Fixture page did not arrive: " + new URL(url).hostname +
    "; observed pages: " + context.pages().map((page) => page.url()).join(", "));
}

function jpegSize(bytes: Buffer): { width: number; height: number } {
  for (let offset = 2; offset + 9 < bytes.length;) {
    const marker = bytes[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error("Screenshot is not a baseline or progressive JPEG.");
}

function confirmationIdOf(error: unknown): string {
  const typed = error as { code?: string; message: string };
  if (typed.code !== "ACTION_REQUIRES_CONFIRMATION") throw error;
  return JSON.parse(typed.message.slice(typed.message.indexOf("{"))).confirmationId as string;
}

async function main(): Promise<void> {
  const { createLegacyLegacySiteFixtureRouter } = await import(fixtureModulePath) as {
    createLegacyLegacySiteFixtureRouter(options: { largeMenu: boolean }): LegacyFixtureRouter;
  };
  const legacyFixture = createLegacyLegacySiteFixtureRouter({ largeMenu: true });
  let slowHelpResponses = 0;
  let redirectHits = 0;
  const editorFixture = process.env.PERSONAL_SMOKE_REAL_EDITORS_ONLY === "1" ? await createEditorFixture() : undefined;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (editorFixture && await editorFixture.handle(req, res, url)) return;
    if (url.hostname === "recovery-site.test" && url.pathname === "/runs" && !url.search) {
      redirectHits++;
      res.writeHead(302, { location: "/runs?v3=false", "cache-control": "no-store" }).end();
      return;
    }
    if (url.hostname === "quality-site.test" && url.pathname === "/slow-help.js") {
      setTimeout(() => {
        slowHelpResponses += 1;
        res.writeHead(200, { "content-type": "application/javascript" }).end("/* fixture */");
      }, 6000);
      return;
    }
    if (url.hostname === "mistert-fixture.test" && legacyFixture.handle(req, res, url)) return;
    if (url.hostname === "consult-site.test" && req.method === "POST") consultationPosts.push(url.pathname);
    const page = pages[url.hostname + url.pathname];
    if (!page) {
      res.writeHead(404).end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(url, Number(url.port)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sitePort = (server.address() as { port: number }).port;
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-frame-smoke-"));
  const latencyEvents: Array<Record<string, unknown>> = [];
  const bridge = await PersonalBrowserBridge.start({
    stateRoot: root, port: 34_000 + Math.floor(Math.random() * 1_000),
    log: (entry) => {
      if (process.env.PERSONAL_SMOKE_PERFORMANCE_ONLY === "1" && entry.event === "browser_latency" && entry.layer === "bridge") latencyEvents.push(entry);
    },
  });
  // Test-only instrumentation in a throwaway profile: expose the exact
  // registered Chrome notification-click listener so headless CI can emulate
  // the user's choice. Never inject this into the production extension.
  const extensionScript = path.join(bridge.extensionDirectory, "service-worker.js");
  const originalScript = await readFile(extensionScript, "utf8");
  const listener = "chrome.notifications?.onButtonClicked?.addListener((id, buttonIndex) => {";
  if (originalScript.split(listener).length !== 2) {
    throw new Error("Chrome notification listener was not found exactly once in the smoke extension.");
  }
  let smokeScript = originalScript.replace(listener,
    "chrome.notifications?.onButtonClicked?.addListener(globalThis.__mcpSmokeNotificationClick = (id, buttonIndex) => {");
  if (process.env.PERSONAL_SMOKE_CDP_RECOVERY_ONLY === "1" || process.env.PERSONAL_SMOKE_FRAME_RECOVERY_ONLY === "1") {
    // Lose only the acknowledgement after one real Chrome input command.
    // The fixture observes the actual effect; no production extension is patched.
    for (const [operation, expression] of [["scroll", "pending"], ["click", "released"], ["hover", "pending"], ["press", "down"]]) {
      const needle = "await waitPersonalInputAcknowledgement(" + expression + ", signal, \"" + operation + "\"";
      if (smokeScript.split(needle).length !== 2) throw new Error("Lost-ack smoke hook missing: " + operation);
      const drop = "(globalThis.__mcpSmokeDropAck === \"" + operation +
        "\" ? (globalThis.__mcpSmokeDropAck = undefined, " + expression +
        ".then(() => new Promise(() => undefined))) : " + expression + ")";
      smokeScript = smokeScript.replace(needle,
        "await waitPersonalInputAcknowledgement(" + drop + ", signal, \"" + operation + "\"");
    }
    for (const operation of ["fill", "type"]) {
      const needle = 'chrome.debugger.sendCommand(target, method, params), signal, "' + operation + '"';
      if (smokeScript.split(needle).length !== 2) throw new Error("Text lost-ack hook missing: " + operation);
      const drop = 'chrome.debugger.sendCommand(target, method, params).then(value => ' +
        'method === "Input.insertText" && globalThis.__mcpSmokeDropAck === "' + operation + '" ' +
        '? (globalThis.__mcpSmokeDropAck = undefined, new Promise(() => undefined)) : value)';
      smokeScript = smokeScript.replace(needle, drop + ', signal, "' + operation + '"');
    }
    const attachNeedle = 'const attaching = chrome.debugger.attach(target, "1.3").then(async () => {';
    if (smokeScript.split(attachNeedle).length !== 2) throw new Error("Late-attach smoke hook missing.");
    smokeScript = smokeScript.replace(attachNeedle, attachNeedle +
      'if (globalThis.__mcpSmokeDelayAttach) { globalThis.__mcpSmokeDelayAttach = false; ' +
      'globalThis.__mcpSmokeLateAttachTab = target.tabId; ' +
      'await new Promise(resolve => setTimeout(resolve, 9000)); }');
    const retireNeedle = 'await chrome.debugger.detach(target);\n      return false;';
    if (smokeScript.split(retireNeedle).length !== 2) throw new Error("Late retirement smoke hook missing.");
    smokeScript = smokeScript.replace(retireNeedle,
      'await chrome.debugger.detach(target); if (globalThis.__mcpSmokeLateAttachTab === target.tabId) ' +
      'globalThis.__mcpSmokeLateRetiredTab = target.tabId; return false;');
    const detachNeedle = 'const detaching = chrome.debugger.detach(target).then(() => {';
    if (smokeScript.split(detachNeedle).length !== 2) throw new Error("Late-detach smoke hook missing.");
    smokeScript = smokeScript.replace(detachNeedle,
      'const detaching = chrome.debugger.detach(target).then(async () => { ' +
      'if (globalThis.__mcpSmokeDelayDetach) { globalThis.__mcpSmokeDelayDetach = false; ' +
      'await new Promise(resolve => setTimeout(resolve, 9000)); globalThis.__mcpSmokeLateDetachTab = target.tabId; }');
    const dragNeedle = 'chrome.debugger.sendCommand(target, method, params), signal, "drag"';
    if (smokeScript.split(dragNeedle).length !== 2) throw new Error("Drag lost-ack hook missing.");
    smokeScript = smokeScript.replace(dragNeedle,
      'chrome.debugger.sendCommand(target, method, params).then(value => ' +
      '(method === "Input.dispatchDragEvent" && params.type === "drop" && globalThis.__mcpSmokeDropAck === "drop" || ' +
      'method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && globalThis.__mcpSmokeDropAck === "release") ' +
      '? (globalThis.__mcpSmokeDropAck = undefined, new Promise(() => undefined)) : value), signal, "drag"');
    for (const [debuggee, operation] of [["target", "operation"], ["debuggee", '"frameSequence"']] as const) {
      const call = 'chrome.debugger.sendCommand(' + debuggee + ', method, params)';
      const needle = call + ', signal, ' + operation + ',';
      if (smokeScript.split(needle).length !== 2) throw new Error("Frame lost-ack hook missing: " + operation);
      const lost = call + '.then(value => (' +
        'params.type === "mouseReleased" && globalThis.__mcpSmokeDropAck === "frame-click" || ' +
        'method === "Input.insertText" && globalThis.__mcpSmokeDropAck === "frame-fill") ' +
        '? (globalThis.__mcpSmokeDropAck = undefined, new Promise(() => undefined)) : value)';
      smokeScript = smokeScript.replace(needle, lost + ', signal, ' + operation + ',');
    }
    const captureNeedle = 'const pending = chrome.debugger.sendCommand(target, method, params);';
    if (smokeScript.split(captureNeedle).length !== 2) throw new Error("Screenshot lost-ack hook missing.");
    smokeScript = smokeScript.replace(captureNeedle,
      'const pending = chrome.debugger.sendCommand(target, method, params).then(value => ' +
      'method === "Page.captureScreenshot" && globalThis.__mcpSmokeDropAck === "screenshot" ' +
      '? (globalThis.__mcpSmokeDropAck = undefined, new Promise(() => undefined)) : value);');
  }
  if (process.env.PERSONAL_SMOKE_CDP_RECOVERY_ONLY !== "1" && process.env.PERSONAL_SMOKE_FRAME_RECOVERY_ONLY !== "1") {
    // Record the native layout returned to the isolated screenshot command.
    // The debugging infobar can resize a real Windows viewport between captures.
    const layoutNeedle = 'const pending = chrome.debugger.sendCommand(target, method, params);';
    if (smokeScript.split(layoutNeedle).length !== 2) throw new Error("Screenshot layout smoke hook missing.");
    smokeScript = smokeScript.replace(layoutNeedle,
      'const pending = chrome.debugger.sendCommand(target, method, params).then(value => { ' +
      'if (method === "Page.getLayoutMetrics") globalThis.__mcpSmokeCaptureLayout = { tabId: target.tabId, view: value.cssVisualViewport, content: value.cssContentSize }; return value; });');
  }
  await writeFile(extensionScript, smokeScript);
  let context: BrowserContext | undefined;
  let nativeProcess: ChildProcess | undefined;
  let nativeBrowser: Browser | undefined;
  try {
    const profile = path.join(root, "profile");
    const args = [
      `--disable-extensions-except=${bridge.extensionDirectory}`,
      `--load-extension=${bridge.extensionDirectory}`,
      "--host-resolver-rules=MAP *.test 127.0.0.1",
      "--no-proxy-server",
      "--site-per-process",
      "--window-size=1280,900",
    ];
    if (process.env.PERSONAL_SMOKE_NATIVE_BACKGROUND === "1") {
      // Playwright's normal launch enables focus emulation on every page,
      // masking the hidden compositor path of the real personal browser.
      let launchError: Error | undefined;
      const child = spawn(process.env.PERSONAL_SMOKE_CHROMIUM || chromium.executablePath(), [
        ...args, "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
        "--disable-default-apps", "--disable-component-update", "--disable-background-networking", "--disable-sync",
        // Match Playwright’s isolated Linux fixture launch, not the installed Chrome.
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        ...(process.env.PERSONAL_SMOKE_HEADFUL === "1" ? [] : ["--headless=new"]),
        "about:blank",
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let startupLog = "";
      child.stderr?.on("data", (chunk: Buffer) => { startupLog = (startupLog + chunk.toString()).slice(-3000); });
      nativeProcess = child;
      child.once("error", error => { launchError = error; });
      let port = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native Chromium exited before CDP startup: " + startupLog);
        const raw = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
        port = Number(raw.split("\n")[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Native Chromium CDP startup timed out: " + startupLog);
      nativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 45_000 });
      context = nativeBrowser.contexts()[0];
      if (!context) throw new Error("Native Chromium did not expose its isolated profile.");
    } else {
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: process.env.PERSONAL_SMOKE_HEADFUL !== "1",
        viewport: null,
        ...(process.env.PERSONAL_SMOKE_CHROMIUM ? { executablePath: process.env.PERSONAL_SMOKE_CHROMIUM } : {}),
        args,
      });
    }
    for (let attempt = 0; attempt < 100 && !bridge.isConnected(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!bridge.isConnected()) throw new Error("The generated extension did not connect to the bridge.");
    report("connection", { ...bridge.connectionInfo(), capabilities: undefined });

    if (editorFixture) {
      await verifyRealEditors(bridge, context, sitePort, waitForFixturePage);
      return;
    }

    if (process.env.PERSONAL_SMOKE_CDP_RECOVERY_ONLY === "1") {
      const url = `http://recovery-site.test:${sitePort}/`;
      const taskId = "personal-cdp-recovery";
      const tabId = (await bridge.open({ url, taskId })).tab.tabId;
      const page = await waitForFixturePage(context, url);
      const worker = context.serviceWorkers().find(candidate => candidate.url().startsWith("chrome-extension://"));
      if (!worker) throw new Error("Smoke extension worker unavailable.");
      await bridge.snapshot({ tabId });
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'scroll'");
      const wheel = await bridge.scroll({ tabId, direction: "down", amount: 600 })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (wheel !== "EXECUTION_OUTCOME_UNKNOWN") throw new Error("Lost wheel acknowledgement was not reported: " + wheel);
      await page.waitForFunction("window.scrollY > 0");
      if (await page.locator("#wheels").textContent() !== "1") throw new Error("Wheel was replayed or not dispatched.");
      const shot = await bridge.screenshot({ tabId });
      if (!shot.sizeBytes) throw new Error("Screenshot did not recover after the wheel timeout.");
      const beforeClick = await bridge.snapshot({ tabId });
      const button = beforeClick.refs.find(ref => ref.name === "Increase");
      if (!button) throw new Error("Missing recovery fixture button.");
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'click'");
      const click = await bridge.click({ tabId, ref: button.ref })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (click !== "EXECUTION_OUTCOME_UNKNOWN") throw new Error("Lost click acknowledgement was not reported: " + click);
      if (await page.locator("#clicks").textContent() !== "Count 1") throw new Error("Click was replayed or not dispatched.");
      const fresh = await bridge.snapshot({ tabId });
      const freshButton = fresh.refs.find(ref => ref.name === "Increase");
      if (!freshButton) throw new Error("Missing button after debugger recovery.");
      const result = await bridge.click({ tabId, ref: freshButton.ref, expect: { text: "Count 2" } });
      if (result.unverified !== false || await page.locator("#clicks").textContent() !== "Count 2") {
        throw new Error("Subsequent guarded click did not recover.");
      }
      const hoverRef = (await bridge.snapshot({ tabId })).refs.find(ref => ref.name === "Run history");
      if (!hoverRef) throw new Error("Missing recovery fixture hover target.");
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'hover'");
      const hover = await bridge.hover({ tabId, ref: hoverRef.ref })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (hover !== "EXECUTION_OUTCOME_UNKNOWN" || !(await page.getByRole("link", { name: "Run history" }).evaluate(el => el.matches(":hover")))) {
        throw new Error("Lost hover acknowledgement or actual hover effect was not verified: " + hover);
      }
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'screenshot'");
      const capture = await bridge.screenshot({ tabId })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (capture !== "BROWSER_WORKER_TIMEOUT") throw new Error("Lost capture acknowledgement was not reported: " + capture);
      const recoveredShot = await bridge.screenshot({ tabId });
      if (!recoveredShot.sizeBytes) throw new Error("Capture did not recover after the timeout.");
      const entry = (await bridge.snapshot({ tabId })).refs.find(ref => ref.name === "Key entry");
      if (!entry) throw new Error("Missing keyboard recovery fixture.");
      await bridge.click({ tabId, ref: entry.ref });
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'press'");
      const press = await bridge.press({ tabId, key: "a b" })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (press !== "EXECUTION_OUTCOME_UNKNOWN" ||
          await page.locator("#key-entry").inputValue() !== "a" ||
          await page.locator("#key-count").textContent() !== "1") {
        throw new Error("Interrupted keyboard sequence replayed or dispatched a subsequent key: " + press);
      }
      const finalShot = await bridge.screenshot({ tabId });
      if (!finalShot.sizeBytes) throw new Error("Screenshot did not recover after keyboard interruption.");
      const fillRef = (await bridge.snapshot({ tabId })).refs.find(ref => ref.name === "Key entry");
      if (!fillRef) throw new Error("Missing field after keyboard recovery.");
      const beforeInsertions = Number(await page.locator("#insert-count").textContent());
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'fill'");
      const fill = await bridge.fill({ tabId, ref: fillRef.ref, value: "replacement" })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (fill !== "EXECUTION_OUTCOME_UNKNOWN" ||
          await page.locator("#key-entry").inputValue() !== "replacement" ||
          Number(await page.locator("#insert-count").textContent()) !== beforeInsertions + 1) {
        throw new Error("Fill acknowledgement or actual insertion was not verified: " + fill);
      }
      await bridge.snapshot({ tabId });
      await worker.evaluate("globalThis.__mcpSmokeDropAck = 'type'");
      const type = await bridge.type({ tabId, text: "!" })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (type !== "EXECUTION_OUTCOME_UNKNOWN" ||
          await page.locator("#key-entry").inputValue() !== "replacement!" ||
          Number(await page.locator("#insert-count").textContent()) !== beforeInsertions + 2) {
        throw new Error("Type acknowledgement or actual insertion was not verified: " + type);
      }
      const finalTextShot = await bridge.screenshot({ tabId });
      if (!finalTextShot.sizeBytes) throw new Error("Screenshot did not recover after text interruption.");
      report("CDP lost-ack recovery", { wheel, click, hover, capture, press, fill, type, scrollY: await page.evaluate("window.scrollY"),
        wheelEvents: 1, clickEvents: 2, keyEvents: 1, textInsertions: 2, screenshotBytes: shot.sizeBytes,
        recoveredScreenshotBytes: recoveredShot.sizeBytes, finalScreenshotBytes: finalTextShot.sizeBytes, nextClickVerified: true });
      const boardUrl = `http://dnd-site.test:${sitePort}/`;
      const boardTab = (await bridge.open({ url: boardUrl, taskId })).tab.tabId;
      const boardPage = await waitForFixturePage(context, boardUrl);
      for (const [source, fault, counter, status, expected] of [
        ["Cartão A", "drop", "#drop-count", "#status", "movido:card"],
        ["Alça", "release", "#release-count", "#pointer", "solto na coluna"],
      ] as const) {
        const refs = (await bridge.snapshot({ tabId: boardTab })).refs;
        const from = refs.find(ref => ref.name === source);
        const to = refs.find(ref => ref.name === "Coluna Concluído");
        if (!from || !to) throw new Error("Missing drag recovery refs.");
        const input = { tabId: boardTab, from: { ref: from.ref }, to: { ref: to.ref } };
        await worker.evaluate(`globalThis.__mcpSmokeDropAck = ${JSON.stringify(fault)}`);
        const result = await bridge.drag(input).then(() => "completed", async (error: { code?: string }) => {
          if (error.code !== "ACTION_REQUIRES_CONFIRMATION") return error.code;
          return bridge.drag({ ...input, confirmationId: confirmationIdOf(error) })
            .then(() => "completed", (next: { code?: string }) => next.code);
        });
        if (result !== "EXECUTION_OUTCOME_UNKNOWN" ||
            await boardPage.locator(counter).textContent() !== "1" ||
            await boardPage.locator(status).textContent() !== expected) {
          throw new Error("Interrupted drag replayed or did not reach its intended target: " + fault + " " + result);
        }
        const recovered = await bridge.screenshot({ tabId: boardTab });
        if (!recovered.sizeBytes) throw new Error("Drag recovery screenshot missing.");
        report("drag acknowledgement recovery", { fault, result, events: 1, screenshotBytes: recovered.sizeBytes });
        if (fault === "drop") await bridge.navigate({ tabId: boardTab, url: boardUrl + "?pointer=1" });
      }
      const lateUrl = url + "?late-attach=1";
      const lateTask = "personal-debugger-transition-recovery";
      const lateTab = (await bridge.open({ url: lateUrl, taskId: lateTask })).tab.tabId;
      const latePage = await waitForFixturePage(context, lateUrl);
      const lateChromeTab = Number(lateTab.split(":")[1]);
      const attachedBefore = await worker.evaluate(`chrome.debugger.getTargets().then(targets =>
        targets.some(t => t.tabId === ${lateChromeTab} && t.attached))`);
      await worker.evaluate("globalThis.__mcpSmokeDelayAttach = true");
      const late = await bridge.screenshot({ tabId: lateTab })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (late !== "BROWSER_WORKER_TIMEOUT") throw new Error("Late debugger attach was not bounded: " + late);
      const retired = await worker.evaluate(`new Promise(resolve => {
        const deadline = Date.now() + 6000;
        const check = async () => {
          const pending = globalThis.__mcpV3PersonalDebuggerTransitions.has("${lateChromeTab}");
          const held = globalThis.__mcpV3PersonalTaskDebuggers.has("${lateChromeTab}");
          const attached = (await chrome.debugger.getTargets()).some(t => t.tabId === ${lateChromeTab} && t.attached);
          const detached = globalThis.__mcpSmokeLateRetiredTab === ${lateChromeTab};
          if (!pending && !held && detached || Date.now() >= deadline) resolve({ pending, held, attached, detached });
          else setTimeout(check, 100);
        };
        void check();
      })`);
      const observation = retired as { pending: boolean; held: boolean; attached: boolean; detached: boolean };
      report("late debugger observation", { attachedBefore, ...observation });
      if (observation.pending || observation.held || !observation.detached) throw new Error("Late debugger session was not retired.");
      const lateShot = await bridge.screenshot({ tabId: lateTab });
      if (!lateShot.sizeBytes) throw new Error("A new capture did not recover after late debugger attachment.");
      report("late debugger attachment recovery", { late, retired, screenshotBytes: lateShot.sizeBytes });
      await worker.evaluate("globalThis.__mcpSmokeDelayDetach = true");
      const delayedFinish = await bridge.finishTask({ taskId: lateTask })
        .then(() => "completed", (error: { code?: string }) => error.code);
      if (delayedFinish !== "BROWSER_WORKER_TIMEOUT" || latePage.isClosed()) {
        throw new Error("Task finished before debugger retirement was confirmed: " + delayedFinish);
      }
      const lateDetach = await worker.evaluate(`new Promise(resolve => {
        const deadline = Date.now() + 6000;
        const check = () => {
          const pending = globalThis.__mcpV3PersonalDebuggerTransitions.has("${lateChromeTab}");
          const held = globalThis.__mcpV3PersonalTaskDebuggers.has("${lateChromeTab}");
          const detached = globalThis.__mcpSmokeLateDetachTab === ${lateChromeTab};
          if (!pending && !held && detached || Date.now() >= deadline) resolve({ pending, held, detached });
          else setTimeout(check, 100);
        };
        check();
      })`) as { pending: boolean; held: boolean; detached: boolean };
      if (lateDetach.pending || lateDetach.held || !lateDetach.detached) {
        throw new Error("Delayed detach did not reconcile.");
      }
      const finished = await bridge.finishTask({ taskId: lateTask });
      if (!finished.completed || !latePage.isClosed()) throw new Error("Task did not finish after confirmed detach.");
      report("late debugger detach recovery", { delayedFinish, ...lateDetach, finished: finished.completed });
      await bridge.finishTask({ taskId });
      console.log("\nPERSONAL BROWSER CDP RECOVERY PASS");
      return;
    }

    if (process.env.PERSONAL_SMOKE_FRAME_RECOVERY_ONLY === "1") {
      const worker = context.serviceWorkers().find(candidate => candidate.url().startsWith("chrome-extension://"));
      if (!worker) throw new Error("Smoke extension worker unavailable.");
      const frameTask = "personal-frame-input-recovery";
      for (const nested of [false, true]) {
        const hostUrl = `http://frame-recovery-site.test:${sitePort}/${nested ? "?nested=1" : ""}`;
        const frameTab = (await bridge.open({ url: hostUrl, taskId: frameTask })).tab.tabId;
        const host = await waitForFixturePage(context, hostUrl);
        const leaf = nested ? host.frameLocator('iframe[name="content"]').frameLocator('iframe[name="leaf"]')
          : host.frameLocator('iframe[name="content"]');
        await leaf.locator("#key-entry").waitFor();
        const framePath = ["content", "leaf"];
        await bridge.snapshot({ tabId: frameTab });
        await worker.evaluate("globalThis.__mcpSmokeDropAck = 'frame-click'");
        const clickResult = await (nested
          ? bridge.frameSequence({ tabId: frameTab, steps: [
            { action: "extract", framePath, locator: { id: "clicks" } },
            { action: "click", framePath, locator: { id: "increase" } },
            { action: "fill", framePath, locator: { id: "key-entry" }, value: "unexpected" },
          ] })
          : bridge.frameClick({ tabId: frameTab, frame: "content", selector: "#increase" }))
          .then(() => ({ code: "completed", message: "" }), (error: { code?: string; message: string }) => error);
        if (clickResult.code !== "EXECUTION_OUTCOME_UNKNOWN" ||
            nested && !clickResult.message.includes("Completed step indexes: [0]") ||
            await leaf.locator("#clicks").textContent() !== "Count 1" ||
            await leaf.locator("#key-entry").inputValue() !== "") {
          throw new Error("Frame click recovery failed: " + JSON.stringify(clickResult));
        }
        const clickShot = await bridge.screenshot({ tabId: frameTab });
        if (!clickShot.sizeBytes) throw new Error("Capture after frame click failed.");
        await bridge.snapshot({ tabId: frameTab });
        await worker.evaluate("globalThis.__mcpSmokeDropAck = 'frame-fill'");
        const fillResult = await (nested
          ? bridge.frameSequence({ tabId: frameTab, steps: [
            { action: "extract", framePath, locator: { id: "clicks" } },
            { action: "fill", framePath, locator: { id: "key-entry" }, value: "frame input" },
            { action: "click", framePath, locator: { id: "increase" } },
          ] })
          : bridge.frameFill({ tabId: frameTab, frame: "content", selector: "#key-entry", value: "frame input" }))
          .then(() => ({ code: "completed", message: "" }), (error: { code?: string; message: string }) => error);
        if (fillResult.code !== "EXECUTION_OUTCOME_UNKNOWN" ||
            nested && !fillResult.message.includes("Completed step indexes: [0]") ||
            await leaf.locator("#key-entry").inputValue() !== "frame input" ||
            await leaf.locator("#insert-count").textContent() !== "1" ||
            await leaf.locator("#clicks").textContent() !== "Count 1") {
          throw new Error("Frame fill recovery failed: " + JSON.stringify(fillResult));
        }
        const fillShot = await bridge.screenshot({ tabId: frameTab });
        if (!fillShot.sizeBytes) throw new Error("Capture after frame fill failed.");
        report("frame input recovery", { nested, click: clickResult.code, fill: fillResult.code,
          clicks: 1, insertions: 1, clickScreenshotBytes: clickShot.sizeBytes, fillScreenshotBytes: fillShot.sizeBytes });
      }
      await bridge.finishTask({ taskId: frameTask });
      console.log("\nPERSONAL BROWSER FRAME RECOVERY PASS");
      return;
    }

    const verifyRichFrames = async (context: BrowserContext) => {
      const taskId = "personal-rich-frame-compatibility";
      const failures: string[] = [];
      for (const variant of ["same", "cross", "nested"]) {
        const url = `http://rich-editor-site.test:${sitePort}/?${variant}=1`;
        const tabId = (await bridge.open({ url, taskId })).tab.tabId;
        const host = await waitForFixturePage(context, url);
        const editor = host.frameLocator('iframe[name="editor"]');
        const leaf = variant === "nested" ? editor.frameLocator('iframe[name="leaf"]') : editor;
        await leaf.locator("#plain").waitFor();
        await bridge.snapshot({ tabId });
        const fill = (id: string, value: string) => variant === "nested"
          ? bridge.frameSequence({ tabId, steps: [{ action: "fill", framePath: ["editor", "leaf"], locator: { id }, value }] })
          : bridge.frameFill({ tabId, frame: "editor", selector: "#" + id, value });
        const attempt = async (id: string, value: string) => fill(id, value)
          .then(() => "completed", (error: { code?: string; message?: string }) => error.code ?? error.message ?? "unknown");
        const plain = await attempt("plain", "replacement");
        const actual = await leaf.locator("#plain").innerText();
        const protectedResult = await attempt("protected", "replacement");
        const protectedText = await leaf.locator("#protected").innerText();
        const token = await leaf.locator("#token").count();
        const readOnly = await attempt("readonly", "replacement");
        const readOnlyText = await leaf.locator("#readonly").innerText();
        const lateToken = await attempt("late-token", "replacement");
        const lateTokenText = await leaf.locator("#late-token").innerText();
        const lateReadOnly = await attempt("late-readonly", "replacement");
        const lateReadOnlyText = await leaf.locator("#late-readonly").innerText();
        const decoy = await leaf.locator("#decoy").inputValue();
        const observation = { variant, plain, actual, protectedResult, protectedText, token, readOnly, readOnlyText,
          lateToken, lateTokenText, lateReadOnly, lateReadOnlyText, decoy };
        report("rich frame compatibility", observation);
        if (plain !== "completed" || actual !== "replacement" ||
            protectedResult !== "ACTION_BLOCKED_BY_POLICY" || token !== 1 || protectedText !== "prefix TOKEN suffix" ||
            readOnly !== "LOCATOR_NOT_FOUND" || readOnlyText !== "locked" ||
            lateToken !== "ACTION_BLOCKED_BY_POLICY" || lateTokenText !== "prefix TOKEN" ||
            lateReadOnly !== "LOCATOR_NOT_FOUND" || lateReadOnlyText !== "locked" || decoy !== "unchanged") {
          failures.push(JSON.stringify(observation));
        }
      }
      await bridge.finishTask({ taskId });
      if (failures.length) throw new Error("Rich frame compatibility failed: " + failures.join("; "));
      console.log("\nPERSONAL BROWSER RICH FRAME COMPATIBILITY PASS");
    };
    if (process.env.PERSONAL_SMOKE_RICH_FRAME_ONLY === "1") {
      await verifyRichFrames(context);
      return;
    }

    const verifyBackgroundCapture = async (context: BrowserContext) => {
      const url = `http://capture-site.test:${sitePort}/`;
      const taskId = "personal-background-capture";
      const target = (await bridge.open({ url, taskId })).tab.tabId;
      const targetPage = await waitForFixturePage(context, url);
      const other = (await bridge.open({ url: url + "?other=1", taskId })).tab.tabId;
      const otherPage = await waitForFixturePage(context, url + "?other=1");
      const worker = context.serviceWorkers().find(candidate => candidate.url().startsWith("chrome-extension://") && new URL(candidate.url()).pathname === "/service-worker.js");
      if (!worker) throw new Error("Smoke extension worker unavailable.");
      const targetChrome = Number(target.split(":")[1]);
      const otherChrome = Number(other.split(":")[1]);
      const selection = () => worker.evaluate(`Promise.all([chrome.tabs.get(${targetChrome}), chrome.tabs.get(${otherChrome})]).then(tabs => tabs.map(tab => tab.active))`) as Promise<boolean[]>;
      const dpr = await targetPage.evaluate("window.devicePixelRatio") as number;
      const region = { x: 300, y: 100, width: 120, height: 80 };
      const modes = [
        ["viewport", { scale: "css" }],
        ["region", { region, scale: "css" }],
        ["region-device", { region, scale: "device" }],
        ["region-zoom", { region, zoom: 2 }],
        ["region-device-zoom", { region, scale: "device", zoom: 2 }],
        ["fullPage", { fullPage: true, scale: "css" }],
        ["fullPage-device", { fullPage: true, scale: "device" }],
      ] as const;
      const capture = async (tabId: string, options: (typeof modes)[number][1]) => {
        const page = tabId === target ? targetPage : otherPage;
        const viewport = await page.evaluate("({ width: window.innerWidth, height: window.innerHeight })") as { width: number; height: number };
        await worker.evaluate("globalThis.__mcpSmokeCaptureLayout = undefined");
        const started = performance.now();
        const shot = await bridge.screenshot({ tabId, ...options }).catch(async (error: unknown) => {
          report("background capture failure", { target: tabId === target ? "A" : "B", options, selection: await selection(),
            visibility: await (tabId === target ? targetPage : otherPage).evaluate("document.visibilityState") });
          throw error;
        });
        const data = (shot as typeof shot & { contentBase64?: string }).contentBase64;
        if (!data || !shot.sizeBytes) throw new Error("Missing screenshot bytes");
        const elapsedMs = Math.round(performance.now() - started);
        // Decode the actual JPEG returned by MCP; do not compare encoded bytes
        // (Chrome can change rendering/encoding when a tab loses selection).
        const pixels = await worker.evaluate(`(async () => {
          const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), char => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          const rgb = [...ctx.getImageData(Math.floor(bitmap.width * .7), Math.floor(bitmap.height * .3), 1, 1).data].slice(0, 3);
          bitmap.close();
          return rgb;
        })()`) as number[];
        const layout = await worker.evaluate("globalThis.__mcpSmokeCaptureLayout") as { tabId: number; view?: { clientWidth: number; clientHeight: number }; content?: { width: number; height: number } } | undefined;
        if (layout && layout.tabId !== Number(tabId.split(":")[1])) throw new Error("Screenshot layout came from another tab.");
        return { size: jpegSize(Buffer.from(data, "base64")), pixels, elapsedMs, viewport, layout };
      };
      await bridge.selectTab({ tabId: target });
      if ((await selection()).join(",") !== "true,false") throw new Error("Target selection not confirmed.");
      const baselines = [];
      for (const [name, options] of modes) {
        const foreground = await capture(target, options);
        baselines.push({ name, options, foreground });
      }
      await bridge.selectTab({ tabId: other });
      const before = await selection();
      if (before.join(",") !== "false,true") throw new Error("Target is not inactive.");
      const initialVisibility = await targetPage.evaluate("document.visibilityState");
      report("background capture visibility", { selection: before, visibility: initialVisibility });
      if (process.env.PERSONAL_SMOKE_NATIVE_BACKGROUND === "1" && initialVisibility !== "hidden") {
        throw new Error("Native background test requires a truly hidden document.");
      }
      for (const { name, options, foreground } of baselines) {
        const otherImage = await capture(other, options);
        const matches = (actual: number[], expected: number[]) => actual.length === 3 &&
          actual.every((value, i) => Math.abs(value - (expected[i] ?? -999)) <= 12);
        if (!matches(foreground.pixels, [184, 50, 36]) || !matches(otherImage.pixels, [24, 74, 144])) {
          throw new Error("Distinct fixture identity not established: " + JSON.stringify({ foreground, otherImage }));
        }
        for (let sample = 0; sample < 2; sample++) {
          const background = await capture(target, options);
          const after = await selection();
          const identityMatches = matches(background.pixels, [184, 50, 36]);
          const wrongTab = matches(background.pixels, [24, 74, 144]);
          const scale = (name.includes("device") ? dpr : 1) * (name.includes("zoom") ? 2 : 1);
          const regionGeometry = (size: { width: number; height: number }) =>
            size.width === Math.round(region.width * scale) && size.height === Math.round(region.height * scale);
          const geometry = (shot: typeof foreground) => {
            if (name.startsWith("region")) return regionGeometry(shot.size);
            if (name.startsWith("fullPage")) return shot.size.height === Math.round(1800 * scale);
            if (dpr === 1) return shot.size.width === shot.viewport.width && shot.size.height === shot.viewport.height;
            const view = shot.layout?.view;
            return !!view && shot.size.width === Math.floor(view.clientWidth) && shot.size.height === Math.floor(view.clientHeight);
          };
          const geometryMatches = geometry(background) && geometry(foreground) && geometry(otherImage);
          if (process.env.PERSONAL_SMOKE_NATIVE_BACKGROUND === "1") {
            await targetPage.waitForFunction('document.visibilityState === "hidden"', undefined, { timeout: 2000 });
          }
          report("background screenshot", { name, dpr, sample, foregroundMs: foreground.elapsedMs,
            backgroundMs: background.elapsedMs, foregroundSize: foreground.size, size: background.size,
            pixels: background.pixels, identityMatches, wrongTab, geometryMatches,
            viewport: background.viewport, layout: background.layout,
            selection: after, visibility: await targetPage.evaluate("document.visibilityState") });
          if (!identityMatches || wrongTab || !geometryMatches || after.join(",") !== "false,true") {
            throw new Error("Inactive screenshot identity/selection mismatch: " + name);
          }
        }
      }
      await bridge.finishTask({ taskId });
      console.log("\nPERSONAL BROWSER BACKGROUND CAPTURE PASS");
    };
    if (process.env.PERSONAL_SMOKE_BACKGROUND_CAPTURE_ONLY === "1") {
      await verifyBackgroundCapture(context);
      return;
    }

    if (process.env.PERSONAL_SMOKE_FOREGROUND_ONLY === "1") {
      const url = `http://recovery-site.test:${sitePort}/`;
      const taskId = "personal-foreground";
      const tabId = (await bridge.open({ url, taskId })).tab.tabId;
      const page = await waitForFixturePage(context, url);
      await bridge.snapshot({ tabId });
      const otherTab = (await bridge.open({ url: url + "?other=1", taskId })).tab.tabId;
      await bridge.selectTab({ tabId: otherTab });
      const worker = context.serviceWorkers().find(candidate => candidate.url().startsWith("chrome-extension://"));
      if (!worker) throw new Error("Smoke extension worker unavailable.");
      const chromeTab = Number(tabId.split(":")[1]);
      const otherChromeTab = Number(otherTab.split(":")[1]);
      const readSelection = () => worker.evaluate(
        `Promise.all([chrome.tabs.get(${chromeTab}), chrome.tabs.get(${otherChromeTab})]).then(tabs => tabs.map(tab => tab.active))`
      ) as Promise<boolean[]>;
      const beforeSelection = await readSelection();
      const started = Date.now();
      const inactive = await bridge.scroll({ tabId, direction: "down", amount: 600 })
        .then(() => "completed", (error: { code?: string }) => error.code);
      const inactiveMs = Date.now() - started;
      // Headless Chromium can report a visible document even in an inactive
      // tab. Chrome's actual selection is the contract, not renderer visibility.
      const afterSelection = await readSelection();
      const backgroundEvidence = { beforeSelection, afterSelection,
        wheelEvents: await page.locator("#wheels").textContent(), scrollY: await page.evaluate("window.scrollY"),
        visibility: await page.evaluate("document.visibilityState") };
      report("inactive scroll observation", { inactive, inactiveMs, ...backgroundEvidence });
      if (inactive !== "STATE_NOT_REACHED" ||
          beforeSelection.join(",") !== "false,true" || afterSelection.join(",") !== "false,true" ||
          backgroundEvidence.wheelEvents !== "0" || backgroundEvidence.scrollY !== 0) {
        throw new Error("Inactive scroll was not refused without changing selection: " + JSON.stringify(backgroundEvidence));
      }
      await bridge.selectTab({ tabId });
      await bridge.snapshot({ tabId });
      const scrolled = await bridge.scroll({ tabId, direction: "down", amount: 600 });
      await page.waitForFunction("window.scrollY > 0");
      if (!scrolled.completed || await page.locator("#wheels").textContent() !== "1") {
        throw new Error("Foreground wheel was not dispatched exactly once.");
      }
      const shot = await bridge.screenshot({ tabId });
      if (!shot.sizeBytes) throw new Error("Foreground capture unavailable.");
      const clickDestination = async (expected: string) => {
        const state = await bridge.snapshot({ tabId });
        const link = state.refs.find(ref => ref.name === "Run history");
        if (!link) throw new Error("Missing redirect fixture link.");
        return bridge.click({ tabId, ref: link.ref, expect: { url: expected, timeoutMs: 2500 } });
      };
      const incomplete = await clickDestination(url + "runs");
      await page.waitForURL(url + "runs?v3=false");
      if (incomplete.unverified !== true) throw new Error("Missing query was incorrectly verified.");
      await bridge.navigate({ tabId, url });
      const exact = await clickDestination(url + "runs?v3=false");
      const destination = await bridge.snapshot({ tabId });
      if (exact.unverified !== false || destination.url !== url + "runs?v3=false" ||
          !destination.content.includes("Run history destination") || redirectHits !== 2) {
        throw new Error("Exact redirected URL did not verify or navigation was replayed.");
      }
      report("foreground and exact URL", { inactive, inactiveMs, wheelEvents: 1,
        screenshotBytes: shot.sizeBytes, incompleteVerified: false, exactVerified: true, redirectHits });
      await bridge.finishTask({ taskId });
      console.log("\nPERSONAL BROWSER FOREGROUND AND URL PASS");
      return;
    }

    if (process.env.PERSONAL_SMOKE_PERFORMANCE_ONLY === "1") {
      const modulePath = "../../benchmarks/browser/benchmark-browser-fast-path.mjs";
      const { summarizeOperationBenchmark } = await import(modulePath) as {
        summarizeOperationBenchmark: (runs: number[], bytes?: number[], warmups?: number) => unknown;
      };
      const url = `http://performance-site.test:${sitePort}/`;
      const taskId = "personal-performance";
      const tabId = (await bridge.open({ url, taskId })).tab.tabId;
      const page = await waitForFixturePage(context, url);
      const warmups = 3;
      const iterations = 20;
      type Sample = { flowMs: number; snapshotMs: number; bridgeMs: number; actionMs: number; queueMs: number; responseBytes: number };
      const samples: Record<"combined" | "separate", Sample[]> = { combined: [], separate: [] };
      let clicks = 0;
      for (let pair = 0; pair < warmups + iterations; pair += 1) {
        const strategies = pair % 2 === 0 ? ["combined", "separate"] as const : ["separate", "combined"] as const;
        for (const strategy of strategies) {
          const started = performance.now();
          const snapshot = await bridge.snapshot({ tabId });
          const snapshotMs = performance.now() - started;
          const ref = snapshot.refs.find((item) => item.name === "Mostrar resultado")?.ref;
          if (!ref) throw new Error("Performance fixture action is missing.");
          const expected = "finished [" + (++clicks) + "]";
          const offset = latencyEvents.length;
          const actionStarted = performance.now();
          if (strategy === "combined") {
            const result = await bridge.click({ tabId, ref, expect: { text: expected, timeoutMs: 4000 } });
            if (result.unverified !== false) throw new Error("Combined postcondition was not verified.");
          } else {
            await bridge.click({ tabId, ref });
            await bridge.wait({ tabId, text: expected, timeoutMs: 4000 });
          }
          const flowMs = performance.now() - actionStarted;
          if (await page.locator("#result").textContent() !== expected ||
              await page.locator("#clicks").textContent() !== String(clicks)) {
            throw new Error("Performance fixture did not produce exactly one action.");
          }
          const events = latencyEvents.slice(offset);
          const operations = strategy === "combined" ? ["browser_click"] : ["browser_click", "browser_wait"];
          if (events.length !== operations.length ||
              events.some((event, index) => event.operation !== operations[index] || event.outcome !== "success")) {
            throw new Error("Unexpected bridge telemetry for " + strategy + ": " + JSON.stringify(events));
          }
          const sum = (key: string): number => events.reduce((total, event) => {
            const value = event[key];
            if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Missing telemetry: " + key);
            return total + value;
          }, 0);
          const sample = { flowMs, snapshotMs, bridgeMs: sum("durationMs"),
            actionMs: sum("extensionActionMs"), queueMs: sum("extensionQueueMs"), responseBytes: sum("responseBytes") };
          if (pair === 0) report("first sample " + strategy, sample);
          if (pair >= warmups) samples[strategy].push(sample);
        }
      }
      for (const strategy of ["combined", "separate"] as const) {
        const values = samples[strategy];
        report("personal performance " + strategy, {
          version: bridge.connectionInfo().extensionVersion, measuredScope: "isolated local bridge; excludes Edge and relay",
          headful: process.env.PERSONAL_SMOKE_HEADFUL === "1", calls: strategy === "combined" ? 1 : 2,
          flow: summarizeOperationBenchmark(values.map((item) => item.flowMs), values.map((item) => item.responseBytes), warmups),
          snapshot: summarizeOperationBenchmark(values.map((item) => item.snapshotMs), [], warmups),
          bridge: summarizeOperationBenchmark(values.map((item) => item.bridgeMs), [], warmups),
          extensionAction: summarizeOperationBenchmark(values.map((item) => item.actionMs), [], warmups),
          extensionQueue: summarizeOperationBenchmark(values.map((item) => item.queueMs), [], warmups),
        });
      }
      await bridge.finishTask({ taskId });
      console.log("\nPERSONAL BROWSER PERFORMANCE PASS");
      return;
    }

    if (process.env.PERSONAL_SMOKE_INTERACTION_QUALITY_ONLY === "1") {
      const candidate = bridge.connectionInfo().capabilities.includes("clickPostconditionV1");
      const measurements: Array<{ calls: number; elapsedMs: number }> = [];
      for (let sample = 0; sample < 3; sample += 1) {
        const url = `http://quality-site.test:${sitePort}/?sample=${sample}`;
        const taskId = "quality-benchmark-" + sample;
        const tabId = (await bridge.open({ url, taskId })).tab.tabId;
        const page = await waitForFixturePage(context, url);
        const ref = (await bridge.snapshot({ tabId })).refs.find((item) => item.name === "Mostrar resultado")?.ref;
        if (!ref) throw new Error("Quality fixture action is missing.");
        const started = performance.now();
        if (candidate) {
          const result = await bridge.click({ tabId, ref, expect: { text: "finished", timeoutMs: 4000 } });
          if (result.unverified !== false) throw new Error("The delayed postcondition was not verified.");
        } else {
          await bridge.click({ tabId, ref });
          await bridge.wait({ tabId, text: "finished", timeoutMs: 4000 });
        }
        measurements.push({ calls: candidate ? 1 : 2, elapsedMs: Math.round(performance.now() - started) });
        if (await page.locator("#result").textContent() !== "finished" ||
            await page.locator("#clicks").textContent() !== "1") throw new Error("Benchmark did not produce exactly one action.");
        if (candidate && sample === 0) {
          const refs = (await bridge.snapshot({ tabId })).refs;
          const noop = refs.find((item) => item.name === "Mostrar nada")!.ref;
          const field = refs.find((item) => item.name === "Entry")!.ref;
          const rich = refs.find((item) => item.name === "Rich")!.ref;
          const help = refs.find((item) => item.name === "Help")!.ref;
          const focusTrap = refs.find((item) => item.name === "Guarded input")!.ref;
          const unverified = await bridge.click({ tabId, ref: noop, expect: { text: "never reached", timeoutMs: 500 } });
          if (unverified.unverified !== true || await page.locator("#clicks").textContent() !== "2") {
            throw new Error("Missing postcondition must not redispatch or report a confirmed effect.");
          }
          const already = await bridge.click({ tabId, ref: noop, expect: { text: "finished" } })
            .then(() => "allowed", (error: { code?: string }) => error.code);
          if (already !== "STATE_NOT_REACHED" || await page.locator("#clicks").textContent() !== "2") {
            throw new Error("A pre-existing condition incorrectly authorized dispatch.");
          }
          const filled = await bridge.fill({ tabId, ref: field, value: "abc def" });
          if (filled.unverified || await page.locator("#entry").inputValue() !== "abc def") {
            throw new Error("Native fill did not verify the value.");
          }
          await page.locator("#entry").evaluate((node) => (node as unknown as {
            setSelectionRange(start: number, end: number): void;
          }).setSelectionRange(4, 7));
          const typed = await bridge.type({ tabId, text: "XYZ" });
          if (typed.unverified || await page.locator("#entry").inputValue() !== "abc XYZ") {
            throw new Error("Native insertion did not verify the selected text.");
          }
          const richResult = await bridge.fill({ tabId, ref: rich, value: "rich replacement" });
          if (richResult.unverified || await page.locator("#rich").innerText() !== "rich replacement") {
            throw new Error("Contenteditable replacement was not verified.");
          }
          const focused = await bridge.fill({ tabId, ref: focusTrap, value: "native focus" });
          if (focused.unverified || await page.locator("#focus-trap").inputValue() !== "native focus" ||
              await page.locator("#decoy").inputValue() !== "unchanged") {
            throw new Error("Trusted focus recovery did not preserve the other field.");
          }
          await page.locator("#help").evaluate((node) => {
            const anchor = node as unknown as { cloneNode(deep: boolean): unknown; replaceWith(node: unknown): void };
            anchor.replaceWith(anchor.cloneNode(true));
          });
          const navigated = await bridge.click({ tabId, ref: help, expect: {
            url: `http://quality-site.test:${sitePort}/help`, timeoutMs: 4000,
          } });
          if (navigated.unverified !== false || slowHelpResponses !== 0) {
            throw new Error("Committed URL was not verified independently of the blocked renderer.");
          }
          await page.waitForURL(`http://quality-site.test:${sitePort}/help`, { timeout: 10000 });
          const destination = await bridge.snapshot({ tabId });
          if (destination.url !== `http://quality-site.test:${sitePort}/help` ||
              !destination.content.includes("Help destination")) {
            throw new Error("Safe recreated link did not recover and leave the tab available for observation.");
          }
        }
        await bridge.finishTask({ taskId });
      }
      report("interaction quality benchmark", { version: bridge.connectionInfo().extensionVersion,
        samples: measurements, measuredScope: "click + expected state; excludes setup and teardown" });
      console.log("\nPERSONAL BROWSER INTERACTION QUALITY PASS");
      return;
    }

    // Real renderer regression: native wheel without coordinates and a
    // partially visible Monaco-shaped editor. The fixture is local and contains
    // no real account, workflow, or third-party data.
    const editorUrl = `http://editor-site.test:${sitePort}/`;
    const editorTask = "personal-editor-robustness";
    const editorTab = (await bridge.open({ url: editorUrl, taskId: editorTask })).tab.tabId;
    const editorPage = await waitForFixturePage(context, editorUrl);
    const editorSnapshot = await bridge.snapshot({ tabId: editorTab });
    const expressionRef = editorSnapshot.refs.find((ref) => ref.name === "Expression")?.ref;
    if (!expressionRef) throw new Error("Editor snapshot did not expose the expression input.");
    await bridge.scroll({ tabId: editorTab, direction: "right", amount: 450 });
    await editorPage.waitForFunction("window.scrollX > 0", undefined, { timeout: 5000 });
    const scrollX = await editorPage.evaluate("window.scrollX");
    const freshEditor = await bridge.snapshot({ tabId: editorTab });
    const freshRef = freshEditor.refs.find((ref) => ref.name === "Expression")?.ref;
    if (!freshRef) throw new Error("Expression ref missing after scroll.");
    await bridge.click({ tabId: editorTab, ref: freshRef });
    await editorPage.locator("#count").waitFor();
    if (await editorPage.locator("#count").textContent() !== "1") {
      throw new Error("Guarded editor click did not reach its rendered surface.");
    }
    const index = await bridge.domIndex({ tabId: editorTab, query: "Expression", visibleOnly: true });
    const indexedRef = index.items.find((item) => item.id === "expression")?.ref;
    if (!indexedRef) throw new Error("Expression missing from DOM index.");
    await bridge.frameSequence({ tabId: editorTab, steps: [{ action: "click", locator: { ref: indexedRef } }] });
    if (await editorPage.locator("#count").textContent() !== "2") {
      throw new Error("Indexed editor click did not reach its rendered surface.");
    }
    await bridge.type({ tabId: editorTab, text: "expression-test" });
    if (await editorPage.locator("#expression").inputValue() !== "expression-test") {
      throw new Error("Native typing did not reach the focused editor input.");
    }
    await editorPage.locator("#overlay").evaluate((el) => (el as unknown as { style: { display: string } }).style.display = "block");
    const blocked = await bridge.click({ tabId: editorTab, ref: freshRef })
      .then(() => "allowed", (error: { code?: string }) => error.code);
    if (blocked !== "BROWSER_CONFIRMATION_INVALID" || await editorPage.locator("#count").textContent() !== "2") {
      throw new Error("An unrelated overlay must block editor clicks.");
    }
    await editorPage.locator("#overlay").evaluate((el) => (el as unknown as { style: { display: string } }).style.display = "none");
    await editorPage.locator("#expression").evaluate((el) => {
      const node = el as unknown as { replaceWith(value: unknown): void; cloneNode(deep: boolean): unknown };
      node.replaceWith(node.cloneNode(true));
    });
    const stale = await bridge.frameSequence({ tabId: editorTab, steps: [{ action: "click", locator: { ref: indexedRef } }] })
      .then(() => "allowed", (error: { code?: string }) => error.code);
    if (stale !== "LOCATOR_NOT_FOUND") throw new Error("Replaced editor accepted a stale indexed reference.");
    const shot = await bridge.screenshot({ tabId: editorTab });
    if (!shot.sizeBytes) throw new Error("Editor screenshot is empty.");
    report("editor robustness", { scrollX, clicks: 2, typed: true, overlay: blocked, stale, screenshotBytes: shot.sizeBytes });
    await bridge.finishTask({ taskId: editorTask });
    if (process.env.PERSONAL_SMOKE_ROBUSTNESS_ONLY === "1") {
      console.log("\nPERSONAL BROWSER ROBUSTNESS SMOKE PASS");
      return;
    }

    // Include both regressions in the existing full headless/headful CI smoke.
    await verifyRichFrames(context);
    await verifyBackgroundCapture(context);

    // Every extension notification uses the embedded data: icon, which Chrome
    // only loads when the extension's CSP allows it.
    const extensionWorker = context.serviceWorkers()
      .find((candidate) => candidate.url().startsWith("chrome-extension://"))!;
    const notification = await extensionWorker.evaluate(`new Promise((resolve) => chrome.notifications.create({
      type: "basic", iconUrl: PERSONAL_NOTIFICATION_ICON, title: "MCP smoke", message: "smoke" },
      (id) => resolve({ id, error: chrome.runtime.lastError?.message ?? null })))`) as { id?: string; error: string | null };
    report("notification", notification);
    if (notification.error || !notification.id) throw new Error("The extension could not show a notification.");

    // Chrome's headless runner has no human to press notification buttons.
    // Observe a real pending notification and invoke the same listener Chrome
    // calls on a user click, from this isolated smoke profile only.
    const decideChromeNotification = async (prefix: string, buttonIndex: 0 | 1): Promise<string> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = await extensionWorker.evaluate(`(async () => {
          const notifications = await chrome.notifications.getAll();
          return Object.keys(notifications).find((candidate) =>
            candidate.startsWith(${JSON.stringify(prefix)}) &&
            (!candidate.startsWith("mcp-action:") || pendingPersonalOneUseConfirmations.has(candidate)));
        })()`) as string | undefined;
        if (id) {
          const dispatched = await extensionWorker.evaluate(`(() => {
            if (typeof globalThis.__mcpSmokeNotificationClick !== "function") return false;
            globalThis.__mcpSmokeNotificationClick(${JSON.stringify(id)}, ${buttonIndex});
            return true;
          })()`) as boolean;
          if (!dispatched) throw new Error("The smoke listener did not receive the Chrome notification click.");
          return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("The expected Chrome notification was not created: " + prefix);
    };

    const verifyNestedOopif = async (context: BrowserContext, tabId: string, url: string) => {
      const beforeSubmissions = submissions.length;
      await bridge.snapshot({ tabId });
      report("frames", (await bridge.profilePage!({ tabId })).frames);
      const steps = [
        { action: "fill" as const, framePath: ["a", "b"], locator: { name: "nome" }, value: "Maria" },
        { action: "select" as const, framePath: ["a", "b"], locator: { name: "uf" }, value: "Minas" },
        { action: "click" as const, framePath: ["a", "b"], locator: { tag: "button", text: "Salvar" } },
        { action: "waitFor" as const, framePath: ["a", "b"], text: "Salvo", timeoutMs: 10_000 },
        { action: "extract" as const, framePath: ["a", "b"], locator: { id: "ok" } },
      ];
      let confirmationId = "";
      try {
        await bridge.frameSequence!({ tabId, steps, timeoutMs: 60_000 });
        throw new Error("A dangerous legacy click ran without confirmation.");
      } catch (error) {
        confirmationId = confirmationIdOf(error);
      }
      if (submissions.length !== beforeSubmissions) throw new Error("The form was submitted before confirmation.");
      const saved = await bridge.frameSequence!({ tabId, timeoutMs: 60_000,
        steps: steps.map((step) => (step.action === "click" ? { ...step, confirmationId } : step)) });
      report("nested OOPIF fill/select/click", saved);
      if (submissions.length !== beforeSubmissions + 1 || !submissions.at(-1)!.includes("nome=Maria") || !submissions.at(-1)!.includes("uf=mg")) {
        throw new Error(`Unexpected submissions ${JSON.stringify(submissions)}`);
      }

      await bridge.snapshot({ tabId });
      const enterSteps = [
        { action: "fill" as const, framePath: ["a", "b"], locator: { id: "busca" }, value: "pedido 42" },
        { action: "press" as const, framePath: ["a", "b"], locator: { id: "busca" }, key: "Enter" },
        { action: "extract" as const, framePath: ["a", "b"], locator: { id: "ok" } },
      ];
      let enterId = "";
      try {
        await bridge.frameSequence!({ tabId, steps: enterSteps });
        throw new Error("Enter ran without confirmation.");
      } catch (error) {
        enterId = confirmationIdOf(error);
      }
      const entered = await bridge.frameSequence!({ tabId,
        steps: enterSteps.map((step) => (step.action === "press" ? { ...step, confirmationId: enterId } : step)) }).catch(async (error: unknown) => {
          const parent = context.pages().find((page) => page.url() === url);
          const child = parent?.frames().find((frame) => frame.name() === "b");
          const state = await child?.evaluate(`(() => {
            const target = document.getElementById("busca");
            const rect = target?.getBoundingClientRect();
            return { activeId: document.activeElement?.id || "", activeTag: document.activeElement?.tagName || "",
              hasFocus: document.hasFocus(), rect: rect?.toJSON(), events: window.__focusTrace || [] };
          })()`).catch(() => null);
          report("nested OOPIF focus diagnostic", state ?? null);
          throw error;
        });
      report("nested OOPIF Enter", entered);
      if (!JSON.stringify(entered.steps.at(-1)).includes("Enter recebido: pedido 42")) {
        throw new Error("Enter did not reach the nested field.");
      }
    };
    if (process.env.PERSONAL_SMOKE_OOPIF_FOCUS_ONLY === "1") {
      for (let sample = 0; sample < 8; sample++) {
        const url = `http://parent-site.test:${sitePort}/?focus-sample=${sample}`;
        const taskId = "personal-oopif-focus-" + sample;
        const tabId = (await bridge.open({ url, taskId })).tab.tabId;
        try { await verifyNestedOopif(context, tabId, url); }
        finally { await bridge.finishTask({ taskId }); }
        report("nested OOPIF focus sample", { sample, completed: true });
      }
      console.log("\nPERSONAL BROWSER OOPIF FOCUS PASS");
      return;
    }
    const parentUrl = `http://parent-site.test:${sitePort}/`;
    const opened = await bridge.open({ url: parentUrl, taskId: "personal-frame-smoke" });
    const tabId = opened.tab.tabId;
    await verifyNestedOopif(context, tabId, parentUrl);

    // Legacy frameset menu: expand a submenu, follow a link targeting another
    // (cross-site) frame, and do not collapse an already expanded level.
    const legacy = await bridge.open({ url: `http://menu-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    await bridge.snapshot({ tabId: legacy.tab.tabId });
    const route = { tabId: legacy.tab.tabId, path: ["Cadastros", "Clientes"], sourceFramePath: ["menu"],
      targetFramePath: ["main"], checkpoint: { action: "extract" as const, framePath: ["main"], locator: { id: "title" } } };
    const navigated = await bridge.navigatePath!(route);
    report("legacy menu path", navigated);
    if (navigated.checkpoint?.step.value !== "Clientes") throw new Error("Menu path did not load the target frame.");
    const again = await bridge.navigatePath!(route);
    if (again.resolved[0]?.strategy !== "already-expanded") throw new Error("An expanded menu level was clicked again.");
    const danger = { tabId: legacy.tab.tabId, path: ["Excluir registros"], sourceFramePath: ["menu"],
      checkpoint: { action: "extract" as const, framePath: ["menu"], locator: { id: "log" } } };
    const deniedPath = bridge.navigatePath!(danger).then(() => "allowed",
      (error: { code?: string }) => error.code);
    await decideChromeNotification("mcp-action:", 1);
    if (await deniedPath !== "ACTION_BLOCKED_BY_POLICY") {
      throw new Error("Chrome denial did not block the dangerous menu path.");
    }
    const approvedPath = bridge.navigatePath!(danger);
    await decideChromeNotification("mcp-action:", 0);
    const deleted = await approvedPath;
    report("one-use Chrome-approved dangerous menu path", deleted.checkpoint);
    if (deleted.checkpoint?.step.value !== "apagado") throw new Error("Confirmed menu path did not run.");

    // Real same-origin frameset matching the large MisterT legacy fixture.
    const fixtureUrl = legacyFixture.indexUrl(`http://mistert-fixture.test:${sitePort}`, "mistert-smoke");
    const fixtureTab = await bridge.open({ url: fixtureUrl, taskId: "personal-frame-smoke" });
    const fixtureId = fixtureTab.tab.tabId;
    const fixturePage = await waitForFixturePage(context, fixtureUrl);
    await fixturePage.frameLocator('frame[name="Menu"]').locator("#stock-root").waitFor();
    const menuFrame = fixturePage.frame({ name: "Menu" });
    if (!menuFrame) throw new Error("MisterT-like fixture menu frame was not found.");
    const compact = await bridge.snapshot({ tabId: fixtureId, filter: "interactive", maxChars: 3500 });
    if (!compact.content.includes('Frame "Menu"') || !compact.content.includes('Frame "MenuContent"')) {
      throw new Error("Compact frameset snapshot omitted the child documents.");
    }
    const indexStarted = performance.now();
    const menuIndex = await bridge.domIndex!({ tabId: fixtureId, framePath: ["Menu"],
      query: "Estoque", visibleOnly: true });
    const indexElapsed = performance.now() - indexStarted;
    const menuRef = menuIndex.items.find((item) => item.id === "stock-root")?.ref;
    if (!menuRef) throw new Error("The large menu index omitted the visible stock entry.");
    report("large legacy menu index", { totalMs: indexElapsed, telemetry: menuIndex.telemetry });
    if (indexElapsed >= 1000) throw new Error("Large-menu indexing exceeded the 1-second target.");
    await bridge.navigatePath!({ tabId: fixtureId, path: ["Estoque", "Operação", "Itens"],
      sourceFramePath: ["Menu"], targetFramePath: ["MenuContent"] });
    const verifiedGrid = await bridge.frameSequence!({ tabId: fixtureId, steps: [
      { action: "waitFor", framePath: ["MenuContent"], locator: { selector: ".finc-fila-head" }, state: "visible" },
      { action: "assert", framePath: ["Menu"], locator: { ref: menuRef }, condition: "exists" },
      { action: "extract", framePath: ["MenuContent"], locator: { selector: ".finc-fila-head" } },
    ] });
    if (verifiedGrid.steps.at(-1)?.value !== "CPX-Finance") {
      throw new Error("Large-menu navigation failed to load the destination, or the menu ref became stale.");
    }
    const pointFor = async (selector: string) => {
      const rect = await menuFrame.locator(selector).boundingBox();
      if (!rect) throw new Error("Expected visible legacy fixture control " + selector);
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    };
    await bridge.screenshot({ tabId: fixtureId });
    const searchPoint = await pointFor("#menu-search");
    const clicked = await bridge.click({ tabId: fixtureId, ...searchPoint });
    if (clicked.clicked?.frame !== "Menu" || clicked.clicked.name !== "Buscar menu") {
      throw new Error("Coordinate click did not identify the actual menu-frame input.");
    }
    await bridge.type({ tabId: fixtureId, text: "itens" });
    if (!(await menuFrame.locator("[data-search-entry]").isVisible())) {
      throw new Error("Native typing did not trigger the menu's onkeyup.");
    }
    await bridge.frameFill!({ tabId: fixtureId, frame: "Menu", selector: "#menu-search", value: "sem resultado" });
    if (await menuFrame.locator("[data-search-entry]").isVisible()) {
      throw new Error("Native frame fill did not trigger the menu's onkeyup.");
    }
    await bridge.screenshot({ tabId: fixtureId });
    const hoverPoint = await pointFor("#stock-root");
    await bridge.sequence({ tabId: fixtureId, steps: [{ action: "hover", ...hoverPoint }] });
    if (await menuFrame.locator("#stock-root").evaluate((element) => (element as { style: { cursor: string } }).style.cursor) !== "pointer") {
      throw new Error("Coordinate hover in a frame sequence did not deliver native mouse movement.");
    }
    fixturePage.on("dialog", () => { /* The extension, not Playwright, handles the dialog. */ });
    await bridge.screenshot({ tabId: fixtureId });
    const alertPoint = await pointFor("#legacy-alert");
    const alertStarted = performance.now();
    const alertResult = await bridge.click({ tabId: fixtureId, ...alertPoint });
    if (alertResult.dialog?.state !== "handled" || alertResult.dialog.message !== "Aviso legado" ||
        performance.now() - alertStarted >= 2000) {
      throw new Error("Unexpected legacy alert was not handled and reported in under 2 seconds.");
    }
    await bridge.screenshot({ tabId: fixtureId });
    const deletePoint = await pointFor("#legacy-delete");
    const deniedFixtureDelete = bridge.click({ tabId: fixtureId, ...deletePoint })
      .then(() => "allowed", (error: { code?: string }) => error.code);
    await decideChromeNotification("mcp-action:", 1);
    if (await deniedFixtureDelete !== "ACTION_BLOCKED_BY_POLICY" ||
        await menuFrame.locator("body").getAttribute("data-deleted") !== null) {
      throw new Error("Destructive coordinate click was not blocked.");
    }
    report("MisterT-like large frameset regression", { indexElapsed, clicked: clicked.clicked,
      alert: alertResult.dialog, destination: verifiedGrid.steps.at(-1)?.value });

    // Real fractional geometry: Chrome rounds the layout dimensions to integers.
    const pixelUrl = `http://pixel-site.test:${sitePort}/`;
    const pixelTab = (await bridge.open({ url: pixelUrl, taskId: "personal-frame-smoke" })).tab.tabId;
    const pixelPage = await waitForFixturePage(context, pixelUrl);
    const pixelInput = pixelPage.frameLocator("iframe").locator("#search");
    await pixelInput.waitFor();
    const geometry = await pixelPage.locator("iframe").evaluate((element) => {
      const host = element as { getBoundingClientRect: () => { width: number; height: number };
        clientWidth: number; clientHeight: number };
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height, clientWidth: host.clientWidth, clientHeight: host.clientHeight };
    });
    if (!(geometry.width < geometry.clientWidth || geometry.height < geometry.clientHeight)) {
      throw new Error("Fractional fixture did not reproduce the old strict comparison.");
    }
    await bridge.snapshot({ tabId: pixelTab });
    await bridge.screenshot({ tabId: pixelTab });
    const pixelBox = await pixelInput.boundingBox();
    if (!pixelBox) throw new Error("Fractional frame target is missing.");
    const fractionalClick = await bridge.click({ tabId: pixelTab,
      x: Math.round(pixelBox.x + pixelBox.width / 2), y: Math.round(pixelBox.y + pixelBox.height / 2) });
    if (fractionalClick.clicked?.frame !== "fractional" || fractionalClick.clicked.name !== "Buscar menu" ||
        !(await pixelInput.evaluate((element) => element === (element as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement))) {
      throw new Error("Fractional frame click did not identify and focus the intended input.");
    }
    await bridge.screenshot({ tabId: pixelTab });
    const dangerBox = await pixelPage.frameLocator("iframe").locator("#danger").boundingBox();
    if (!dangerBox) throw new Error("Fractional destructive fixture target is missing.");
    const deniedFractional = bridge.click({ tabId: pixelTab,
      x: Math.round(dangerBox.x + dangerBox.width / 2), y: Math.round(dangerBox.y + dangerBox.height / 2) })
      .then(() => "allowed", (error: { code?: string }) => error.code);
    await decideChromeNotification("mcp-action:", 1);
    if (await deniedFractional !== "ACTION_BLOCKED_BY_POLICY" ||
        await pixelPage.frameLocator("iframe").locator("body").getAttribute("data-deleted") !== null) {
      throw new Error("Fractional geometry must not authorize destructive clicks.");
    }
    report("fractional frame geometry", { geometry, clicked: fractionalClick.clicked });

    // A real toolbar share grants consultation and scripts, not typed POST writes.
    const consultationPage = await context.newPage();
    await consultationPage.goto(`http://consult-site.test:${sitePort}/MisterT.asp`);
    const consultationChromeId = await extensionWorker.evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://consult-site.test/*" });
      if (!tab || !(await personalBrowserToolbarClick(tab))) throw new Error("Unable to share consultation fixture");
      return tab.id;
    })()`) as number;
    const consultationTab = "personal:" + consultationChromeId;
    await bridge.snapshot({ tabId: consultationTab });
    const sharedScript = await bridge.evaluate({ tabId: consultationTab, function: "() => document.title" });
    if (sharedScript.value !== "Itens do Estoque") {
      throw new Error("Toolbar sharing did not authorize a script on the shared origin.");
    }
    report("shared JavaScript authorization", { value: sharedScript.value });
    const consultaIndex = await bridge.domIndex!({ tabId: consultationTab, query: "Pesquisar", limit: 5 });
    if (consultaIndex.items.length !== 1 || consultaIndex.items[0]?.text !== "Pesquisar") {
      throw new Error("Native submit label is missing from the legacy index.");
    }
    const deniedWrite = await bridge.frameSequence!({ tabId: consultationTab, steps: [
      { action: "click", locator: { name: "IN3" } },
    ] }).then(() => "allowed", (error: { code?: string }) => error.code);
    if (deniedWrite !== "ACTION_REQUIRES_CONFIRMATION" || consultationPosts.length !== 0) {
      throw new Error("Sharing a tab must not authorize writes.");
    }
    const consulted = await bridge.frameSequence!({ tabId: consultationTab, steps: [
      { action: "fill", locator: { name: "IN1" }, value: "parafuso" },
      { action: "click", locator: { ref: consultaIndex.items[0]!.ref } },
      { action: "waitFor", locator: { id: "result" }, state: "visible" },
      { action: "extract", locator: { id: "result" } },
    ], timeoutMs: 20000 });
    if (!consulted.completed || consulted.steps.at(-1)?.value !== "Consulta concluída" || Number(consultationPosts.length) !== 1) {
      throw new Error("Shared consultation did not complete exactly once without an additional confirmation.");
    }
    report("shared native consultation", { result: consulted.steps.at(-1)?.value, deniedWrite, posts: consultationPosts.length });
    await extensionWorker.evaluate(`(async () => {
      const tab = await chrome.tabs.get(${consultationChromeId});
      return personalBrowserToolbarClick(tab);
    })()`);
    if ((await bridge.tabs({})).tabs.some((tab) => tab.tabId === consultationTab) || consultationPage.isClosed()) {
      throw new Error("Revoking the share did not preserve and release the original tab.");
    }
    await consultationPage.close();

    // Safe pagination follows only same-origin rel=next, never a bare "Próxima".
    const list = await bridge.open({ url: `http://list-site.test:${sitePort}/list?page=1`, taskId: "personal-frame-smoke" });
    const paged = await bridge.extract({ tabId: list.tab.tabId, completion: "document-and-safe-pagination" });
    report("safe pagination", { value: paged.value, completeness: paged.completeness });
    if (paged.completeness?.status !== "complete" || paged.completeness.pages !== 3 ||
        !String(paged.value).includes("Item 3") || listHits.some((hit) => hit.includes("99"))) {
      throw new Error("Safe pagination did not stop at the last rel=next page.");
    }
    const cross = await bridge.open({ url: `http://list-site.test:${sitePort}/cross`, taskId: "personal-frame-smoke" });
    const refused = await bridge.extract({ tabId: cross.tab.tabId, completion: "document-and-safe-pagination" });
    report("cross-origin pagination", refused.completeness);
    if (refused.completeness?.reason !== "unsafe-pagination") throw new Error("Cross-origin rel=next was followed.");

    // Drop zone upload: trusted CDP drag events deliver the staged file once confirmed.
    const upload = await bridge.open({ url: `http://upload-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    const uploadTab = upload.tab.tabId;
    const uploadRefs = (await bridge.snapshot({ tabId: uploadTab })).refs;
    const zoneRef = uploadRefs.find((item) => item.name === "Soltar arquivos")?.ref;
    const inputRef = uploadRefs.find((item) => item.name.startsWith("Arquivo"))?.ref;
    if (!zoneRef || !inputRef) throw new Error(`Upload page refs missing: ${JSON.stringify(uploadRefs)}`);
    const file = { name: "nota.txt", mimeType: "text/plain", contentBase64: Buffer.from("conteudo do drop").toString("base64") };
    let dropId = "";
    try {
      await bridge.upload({ tabId: uploadTab, files: [file], dropRef: zoneRef });
      throw new Error("A drop zone upload ran without confirmation.");
    } catch (error) {
      dropId = confirmationIdOf(error);
    }
    const dropped = await bridge.upload({ tabId: uploadTab, files: [file], dropRef: zoneRef, confirmationId: dropId });
    const dropText = await bridge.extract({ tabId: uploadTab, selector: "#out" });
    report("drop zone upload", { dropped, dropText: dropText.value });
    if (!String(dropText.value).includes("drop:nota.txt:conteudo do drop")) throw new Error("The drop zone did not receive the file.");
    await bridge.snapshot({ tabId: uploadTab });
    let inputId = "";
    const inputFile = { ...file, name: "campo.txt", contentBase64: Buffer.from("conteudo do campo").toString("base64") };
    try {
      await bridge.upload({ tabId: uploadTab, files: [inputFile], inputRef });
    } catch (error) {
      inputId = confirmationIdOf(error);
    }
    await bridge.upload({ tabId: uploadTab, files: [inputFile], inputRef, confirmationId: inputId });
    // Pages often read selected or dropped files later, e.g. when a form submits.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const rereadRef = (await bridge.snapshot({ tabId: uploadTab })).refs.find((item) => item.name === "Reler arquivos")?.ref;
    await bridge.click({ tabId: uploadTab, ref: rereadRef! });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reread = await bridge.extract({ tabId: uploadTab, selector: "#again" });
    report("files read after the upload call returned", reread.value);
    if (reread.value !== "drop=conteudo do drop input=conteudo do campo") {
      throw new Error("Staged upload files did not outlive the upload call.");
    }

    // Console history survives repeated reads and MCP navigations without duplicates.
    const logs = await bridge.open({ url: `http://log-site.test:${sitePort}/one`, taskId: "personal-frame-smoke" });
    await bridge.console({ tabId: logs.tab.tabId });
    const repeated = await bridge.console({ tabId: logs.tab.tabId });
    await bridge.navigate({ tabId: logs.tab.tabId, url: `http://log-site.test:${sitePort}/two` });
    const history = await bridge.console({ tabId: logs.tab.tabId });
    report("console history", history.text);
    const once = (text: string, line: string) => text.split(line).length === 2;
    if (!once(repeated.text, "[error] falha na primeira página") || !once(history.text, "[info] primeira pronta") ||
        !once(history.text, "[warning] aviso na segunda página") ||
        history.text.indexOf("primeira pronta") > history.text.indexOf("aviso na segunda")) {
      throw new Error("Console history was duplicated or lost across navigation.");
    }

    // Native HTML5 drag and drop between refs (draggable source, drop handler target).
    const board = await bridge.open({ url: `http://dnd-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    const boardRefs = (await bridge.snapshot({ tabId: board.tab.tabId })).refs;
    const card = boardRefs.find((item) => item.name === "Cartão A")?.ref;
    const column = boardRefs.find((item) => item.name === "Coluna Concluído")?.ref;
    if (!card || !column) throw new Error(`Board refs missing: ${JSON.stringify(boardRefs)}`);
    const dragInput = { tabId: board.tab.tabId, from: { ref: card }, to: { ref: column } };
    try {
      await bridge.drag(dragInput);
    } catch (error) {
      await bridge.drag({ ...dragInput, confirmationId: confirmationIdOf(error) });
    }
    const moved = await bridge.extract({ tabId: board.tab.tabId, selector: "#status" });
    report("html5 drag and drop", moved.value);
    if (moved.value !== "movido:card") throw new Error("Native HTML5 drop did not reach the target.");
    const knob = boardRefs.find((item) => item.name === "Alça")?.ref;
    const pointerInput = { tabId: board.tab.tabId, from: { ref: knob! }, to: { ref: column } };
    try {
      await bridge.drag(pointerInput);
    } catch (error) {
      await bridge.drag({ ...pointerInput, confirmationId: confirmationIdOf(error) });
    }
    const pointer = await bridge.extract({ tabId: board.tab.tabId, selector: "#pointer" });
    report("pointer drag", pointer.value);
    if (pointer.value !== "solto na coluna") throw new Error("Pointer-based drag did not end on the target.");

    // Zoom re-renders a clipped region at a higher resolution to read small text.
    const zoomed = await bridge.screenshot({ tabId: board.tab.tabId, region: { x: 0, y: 0, width: 100, height: 40 }, zoom: 4 });
    const screenshotBytes = (zoomed as typeof zoomed & { contentBase64?: string }).contentBase64;
    if (!screenshotBytes) throw new Error("Screenshot returned no in-memory image.");
    const zoomedSize = jpegSize(Buffer.from(screenshotBytes, "base64"));
    report("zoomed region", zoomedSize);
    if (zoomedSize.width !== 400 || zoomedSize.height !== 160) throw new Error("Zoomed region has the wrong resolution.");

    // An earlier screenshot is dropped by path; its bytes never pass through the caller.
    const zoneAgain = (await bridge.snapshot({ tabId: uploadTab })).refs.find((item) => item.name === "Soltar arquivos")?.ref;
    const shotUpload = { tabId: uploadTab, dropRef: zoneAgain!, files: [{ name: "quadro.jpg", screenshotPath: zoomed.path }] };
    try {
      await bridge.upload(shotUpload);
    } catch (error) {
      await bridge.upload({ ...shotUpload, confirmationId: confirmationIdOf(error) });
    }
    const shotKind = await bridge.extract({ tabId: uploadTab, selector: "#kind" });
    report("screenshot upload", shotKind.value);
    if (shotKind.value !== `tipo=image/jpeg bytes=${zoomed.sizeBytes}`) {
      throw new Error("The earlier screenshot did not reach the drop zone intact.");
    }

    // Slow typing sends accented and non-Latin characters as real keystrokes and
    // commits CJK runs through an IME composition.
    const typing = await bridge.open({ url: `http://type-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    const fieldRef = (await bridge.snapshot({ tabId: typing.tab.tabId })).refs
      .find((item) => item.name === "Campo internacional")?.ref;
    if (!fieldRef) throw new Error("The typing field has no ref.");
    await bridge.click({ tabId: typing.tab.tabId, ref: fieldRef });
    await bridge.type({ tabId: typing.tab.tabId, text: "Ação ß 東京 🙂", slowly: true });
    const typed = JSON.stringify((await bridge.extract({ tabId: typing.tab.tabId, selector: "body" })).value);
    report("international typing", typed);
    if (!typed.includes("A·ç·ã·o· ·ß· · ·🙂·") || !typed.includes("[東京]") || !typed.includes("valor=Ação ß 東京 🙂")) {
      throw new Error("International slow typing lost keystrokes or the IME commit.");
    }

    // Plain ref hover/click without coordinates must still serialize cleanly.
    const plain = await bridge.open({ url: `http://plain-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    const snapshot = await bridge.snapshot({ tabId: plain.tab.tabId });
    const ref = snapshot.refs.find((item) => item.name.includes("Mostrar"))?.ref;
    if (!ref) throw new Error("The plain page button has no ref.");
    await bridge.hover({ tabId: plain.tab.tabId, ref });
    await bridge.click({ tabId: plain.tab.tabId, ref });
    const shown = await bridge.extract({ tabId: plain.tab.tabId, selector: "#out" });
    report("plain ref click", shown);
    if (!JSON.stringify(shown).includes("Mostrado")) throw new Error("Plain ref click did not run.");

    // One recording feeds a trace and a video. Both come out as WebM files Chrome
    // plays, each timed from its own start, and the trace lists the clicks.
    const recTab = (await bridge.open({ url: `http://rec-site.test:${sitePort}/`, taskId: "personal-frame-smoke" })).tab.tabId;
    const recPage = await waitForFixturePage(context, `http://rec-site.test:${sitePort}/`);
    const recRefs = (await bridge.snapshot({ tabId: recTab })).refs;
    const paintRef = recRefs.find((item) => item.name === "Pintar")?.ref;
    const clearRef = recRefs.find((item) => item.name === "Limpar")?.ref;
    if (!paintRef || !clearRef) throw new Error(`Recording page refs missing: ${JSON.stringify(recRefs)}`);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 800));
    // A slow renderer can take longer than the nominal capture interval.
    // Wait for the actual recorded frame, not a guessed delay after a click.
    // Test-only read of accepted frame metadata; no image data is exposed.
    const stagedFrames = () => (bridge as unknown as {
      recorder: { byTab: Map<string, { frames: ReadonlyArray<{ at: number }> }> };
    }).recorder.byTab.get(recTab)?.frames ?? [];
    const waitRecordedColor = async (color: "green" | "white", minimumFrames: number) => {
      const captured = await extensionWorker.evaluate(`(async () => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const recording = globalThis.__mcpV3PersonalRecordings?.get(${JSON.stringify(recTab.slice("personal:".length))});
          if (!recording) return false;
          await recording.flight;
          const canvas = recording.canvas;
          if (canvas) {
            const [r, g, b] = canvas.getContext("2d").getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
            if (${JSON.stringify(color)} === "green" ? g > 110 && r < 80 && b < 80 : r > 220 && g > 220 && b > 220) return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      })()`);
      if (captured !== true) throw new Error("Recording never captured " + color + " fixture state.");
      const deadline = Date.now() + 5000;
      while (stagedFrames().length < minimumFrames && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const frame = stagedFrames().at(-1);
      if (!frame || stagedFrames().length < minimumFrames) {
        throw new Error("The gateway did not accept the " + color + " frame.");
      }
      return frame.at;
    };
    await bridge.traceStart({ tabId: recTab });
    const videoStarted = await bridge.videoStart({ tabId: recTab, filename: "gravacao" });
    const videoStartedAt = Date.now();
    await waitRecordedColor("white", 1);
    await pause();
    const beforePaint = stagedFrames().length;
    await bridge.click({ tabId: recTab, ref: paintRef });
    if (await recPage.evaluate("getComputedStyle(document.body).backgroundColor") !== "rgb(0, 192, 0)") {
      throw new Error("Paint click did not change the fixture.");
    }
    const paintedAt = await waitRecordedColor("green", beforePaint + 1);
    await pause();
    const video = await bridge.videoStop({ tabId: recTab });
    const midway = await bridge.diagnostics({ tabId: recTab });
    const beforeClear = stagedFrames().length;
    await bridge.click({ tabId: recTab, ref: clearRef });
    if (await recPage.evaluate("getComputedStyle(document.body).backgroundColor") !== "rgb(255, 255, 255)") {
      throw new Error("Clear click did not change the fixture.");
    }
    const clearedAt = await waitRecordedColor("white", beforeClear + 1);
    await pause();
    const trace = await bridge.traceStop({ tabId: recTab });
    const traceJson = JSON.parse(await readFile(trace.files.find((file) => file.path.endsWith("trace.json"))!.path, "utf8")) as {
      startedAt: string; video: string | null; actions: Array<{ operation: string; outcome: string; atMs: number; durationMs: number; target?: { ref?: string } }>;
    };
    const clicks = traceJson.actions.filter((action) => action.operation === "click");
    // Plays a recording in Chrome and reads the center pixel at each time; a
    // negative time counts back from the end.
    const play = async (file: string, times: number[]) => recPage.evaluate(`(async () => {
      const element = document.createElement("video");
      element.muted = true;
      await new Promise((resolve, reject) => {
        element.onloadeddata = resolve;
        element.onerror = () => reject(new Error("video error " + element.error?.code));
        element.src = "data:video/webm;base64," + ${JSON.stringify((await readFile(file)).toString("base64"))};
      });
      const canvas = document.createElement("canvas");
      canvas.width = element.videoWidth;
      canvas.height = element.videoHeight;
      const context2d = canvas.getContext("2d");
      const pixels = [];
      for (const time of ${JSON.stringify(times)}) {
        // Seek near zero to decode the initial frame before drawing it.
        const target = time < 0 ? element.duration + time : time === 0 ? 0.05 : time;
        if (Math.abs(element.currentTime - target) > 0.001) {
          await new Promise((resolve) => { element.onseeked = resolve; element.currentTime = target; });
        }
        context2d.drawImage(element, 0, 0);
        pixels.push([...context2d.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data].slice(0, 3));
      }
      return { duration: element.duration, width: element.videoWidth, height: element.videoHeight, pixels };
    })()`) as Promise<{ duration: number; width: number; height: number; pixels: number[][] }>;
    const green = (pixel: number[] | undefined) => !!pixel && pixel[1]! > 110 && pixel[0]! < 80 && pixel[2]! < 80;
    const white = (pixel: number[] | undefined) => !!pixel && pixel.every((value) => value > 220);
    // Both consumers must contain the captured transition at their own time origin.
    const paintClick = clicks.find((action) => action.target?.ref === paintRef);
    const clearClick = clicks.find((action) => action.target?.ref === clearRef);
    const videoPainted = (paintedAt - videoStartedAt + 100) / 1000;
    const tracePainted = (paintedAt - Date.parse(traceJson.startedAt) + 100) / 1000;
    const videoPlay = await play(video.path, [0, videoPainted, -0.05]);
    const traceCleared = (clearedAt - Date.parse(traceJson.startedAt) + 100) / 1000;
    const tracePlay = await play(trace.files.find((file) => file.path.endsWith("trace.webm"))!.path, [0, tracePainted, traceCleared, -0.05]);
    report("recording", { videoStarted, video, midway: { traceActive: midway.traceActive, videoActive: midway.videoActive },
      videoPlay, tracePlay, traceFiles: trace.files.map((file) => path.basename(file.path)), clicks });
    if (!video.path.endsWith("gravacao.webm") || video.path !== videoStarted.path || video.sizeBytes <= 0 ||
        !midway.traceActive || midway.videoActive || traceJson.video !== "trace.webm" || trace.files.length !== 2 ||
        clicks.length !== 2 || clicks.some((action) => action.outcome !== "success") || !paintClick || !clearClick ||
        videoPlay.duration < 1 || videoPlay.width < 64 || !white(videoPlay.pixels[0]) || !green(videoPlay.pixels[1]) || !green(videoPlay.pixels[2]) ||
        tracePlay.duration < videoPlay.duration || !white(tracePlay.pixels[0]) || !green(tracePlay.pixels[1]) ||
        !white(tracePlay.pixels[2]) || !white(tracePlay.pixels[3])) {
      throw new Error("The personal recording did not show the page as it changed.");
    }

    // A real window resize moves the owned tab out of the shared window first,
    // so the window the user browses in keeps its size.
    const userPage = context.pages()[0]!;
    const outerSize = () => userPage.evaluate<string>("[outerWidth, outerHeight].join('x')");
    const userWindowBefore = await outerSize();
    const firstSize = await bridge.viewport({ tabId: plain.tab.tabId, preset: "window", width: 900, height: 700 });
    const secondSize = await bridge.viewport({ tabId: plain.tab.tabId, preset: "window", width: 1100, height: 760 });
    const sharedWindowTab = await bridge.viewport({ tabId: typing.tab.tabId, preset: "desktop" });
    await bridge.viewport({ tabId: typing.tab.tabId, preset: "reset" });
    const userWindowAfter = await outerSize();
    report("window resize", { firstSize, secondSize, userWindowBefore, userWindowAfter });
    if (firstSize.window?.width !== 900 || secondSize.window?.width !== 1100 || userWindowBefore !== userWindowAfter ||
        firstSize.emulated || secondSize.width <= firstSize.width || firstSize.width > 900 ||
        !sharedWindowTab.emulated) {
      throw new Error("The owned tab's window did not resize as requested.");
    }
    // Exercise internal controls from the extension options test page, not a toolbar popup.
    // A user-shared tab remains protected against automatic closure.
    const userTab = await context.newPage();
    await userTab.goto(`http://share-site.test:${sitePort}/`);
    const otherTab = await context.newPage();
    await otherTab.goto(`http://plain-site.test:${sitePort}/?segredo=1#x`);
    const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith("chrome-extension://"))!;
    const popup = await context.newPage();
    await popup.goto(new URL("secret-provision.html", worker.url()).href);
    const popupCall = (type: string, extra: Record<string, unknown> = {}) => popup.evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ url: "http://share-site.test/*" });
      return chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, tabId: tab.id, ...${JSON.stringify(extra)} });
    })()`) as Promise<Record<string, unknown>>;
    const before = (await bridge.tabs({})).tabs.length;
    const sharedState = await popupCall("mcp-tab-share");
    await popupCall("mcp-tab-context", { enabled: true });
    const listing = await bridge.tabs({});
    const shared = listing.tabs.find((tab) => tab.ownership === "user");
    report("shared tab", { sharedState, shared, openTabs: listing.openTabs });
    if (!shared || listing.tabs.length !== before + 1 ||
        !listing.openTabs?.some((tab) => tab.url === `http://plain-site.test:${sitePort}/`) ||
        JSON.stringify(listing.openTabs).includes("segredo")) {
      throw new Error("The shared tab or the opt-in tab list is wrong.");
    }
    const markRef = (await bridge.snapshot({ tabId: shared.tabId })).refs.find((item) => item.name === "Marcar")?.ref;
    await bridge.click({ tabId: shared.tabId, ref: markRef! });
    const marked = await bridge.extract({ tabId: shared.tabId, selector: "#estado" });
    if (marked.value !== "clicado pelo MCP") throw new Error("MCP could not act in the shared tab.");
    await bridge.closeTab({ tabId: shared.tabId }).then(
      () => { throw new Error("MCP closed a tab the user shared."); },
      (error: { code?: string }) => { if (error.code !== "TAB_PROTECTED") throw error; },
    );
    await popupCall("mcp-tab-unshare");
    await popupCall("mcp-tab-context", { enabled: false });
    const afterUnshare = await bridge.tabs({});
    if (afterUnshare.tabs.some((tab) => tab.tabId === shared.tabId) || afterUnshare.openTabs || userTab.isClosed()) {
      throw new Error("Stopping the share did not release the tab cleanly.");
    }

    // Handing a tab to the user: MCP stays blocked until Chrome notification handback;
    // a timed-out wait does not take the turn back.
    const handTab = plain.tab.tabId;
    const handChromeId = Number(handTab.slice("personal:".length));
    const popupFor = (type: string) => popup.evaluate(
      `chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, tabId: ${handChromeId} })`) as Promise<Record<string, unknown>>;
    const pending = await bridge.wait({ tabId: handTab, forUser: "Faça login no site de teste", timeoutMs: 300 })
      .then(() => "completed", (error: { code?: string }) => error.code);
    const pausedRead = await bridge.snapshot({ tabId: handTab }).then(() => "allowed", (error: { code?: string }) => error.code);
    const waitingState = await popupFor("mcp-tab-status");
    const resumed = await popupFor("mcp-tab-resume");
    const handedBack = await bridge.wait({ tabId: handTab, forUser: "Faça login no site de teste", timeoutMs: 300 });
    const afterHandoff = await bridge.snapshot({ tabId: handTab });
    report("user handoff", { pending, pausedRead, waitingState, resumed, handedBack });
    if (pending !== "STATE_NOT_REACHED" || pausedRead !== "EXECUTION_STATE_INVALID" ||
        waitingState.waiting !== "Faça login no site de teste" || resumed.ok !== true || resumed.waiting ||
        !handedBack.completed || afterHandoff.refs.length === 0) {
      throw new Error("The user handoff did not pause and resume MCP as expected.");
    }

    // Browsing a public site and navigating to another public host should work
    // without an MCP plan window, while sensitive scripts retain their guard.
    const autonomousTask = "personal-autonomous-smoke";
    const autonomousTab = (await bridge.open({
      url: `http://share-site.test:${sitePort}/`, taskId: autonomousTask,
    })).tab.tabId;
    const autonomousRef = (await bridge.snapshot({ tabId: autonomousTab }))
      .refs.find((item) => item.name === "Marcar")?.ref;
    await bridge.click({ tabId: autonomousTab, ref: autonomousRef! });
    const autonomousMarked = await bridge.extract({ tabId: autonomousTab, selector: "#estado" });
    const acrossHost = await bridge.navigate({
      tabId: autonomousTab, url: `http://plain-site.test:${sitePort}/`,
    });
    report("no-plan navigation", { autonomousMarked, acrossHost });
    if (autonomousMarked.value !== "clicado pelo MCP" ||
        !acrossHost.tab.url?.includes("plain-site.test")) {
      throw new Error("Routine browser actions unexpectedly required a plan.");
    }
    await bridge.finishTask({ taskId: autonomousTask });

    const errorCode = (error: { code?: string }) => error.code;
    // A refused script asks Chrome for site approval. Native notification
    // buttons grant only scoped use; retired global auto-site grants stay off.
    const popupTab = (type: string, chromeTabId: number, extra: Record<string, unknown> = {}) => popup.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({ type, tabId: chromeTabId, ...extra })})`) as Promise<Record<string, unknown>>;
    const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        const value = await read();
        if (done(value) || attempt >= 40) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const approvalTask = "personal-approval-smoke";
    const siteTab = (await bridge.open({ url: `http://share-site.test:${sitePort}/`, taskId: approvalTask })).tab.tabId;
    const siteChromeId = Number(siteTab.slice("personal:".length));
    await bridge.snapshot({ tabId: siteTab });
    const title = { tabId: siteTab, function: "() => document.title" };
    const firstScript = await bridge.evaluate(title).then(() => "allowed", (error: Error & { code?: string }) =>
      error.code + (error.message.includes("siteApproval") ? "+siteApproval" : ""));
    const asked = await until(() => popupTab("mcp-tab-status", siteChromeId), (state) => state.approval === "execute-script");
    await decideChromeNotification("mcp-approval:" + siteChromeId, 0);
    const approvedState = await popupTab("mcp-tab-status", siteChromeId);
    const granted = await until(() => bridge.evaluate(title).then((result) => result.value, errorCode),
      (value) => value === "Minha aba");
    const autoTab = (await bridge.open({ url: `http://plain-site.test:${sitePort}/`, taskId: approvalTask })).tab.tabId;
    const autoChromeId = Number(autoTab.slice("personal:".length));
    await bridge.snapshot({ tabId: autoTab });
    const autoTitle = { tabId: autoTab, function: "() => document.title" };
    const beforeAuto = await bridge.evaluate(autoTitle).then(() => "allowed", errorCode);
    const autoState = await popupTab("mcp-tab-auto", autoChromeId, { enabled: true });
    const automatic = await bridge.evaluate(autoTitle).then((result) => result.value, errorCode);
    const noAutoSites = (await popupTab("mcp-tab-status", autoChromeId)).autoSites;
    await bridge.finishTask({ taskId: approvalTask });
    const nextTab = (await bridge.open({ url: `http://share-site.test:${sitePort}/`, taskId: approvalTask })).tab.tabId;
    await bridge.snapshot({ tabId: nextTab });
    const afterTask = await bridge.evaluate({ ...title, tabId: nextTab }).then(() => "allowed", errorCode);
    await bridge.finishTask({ taskId: approvalTask });
    const userChromeId = Number(shared.tabId.slice("personal:".length));
    await popupTab("mcp-tab-share", userChromeId);
    await bridge.snapshot({ tabId: shared.tabId });
    const sharedTitle = { tabId: shared.tabId, function: "() => document.title" };
    const sharedFirst = await bridge.evaluate(sharedTitle).then(() => "allowed", errorCode);
    await until(() => popupTab("mcp-tab-status", userChromeId), (state) => state.approval === "execute-script");
    await decideChromeNotification("mcp-approval:" + userChromeId, 0);
    const sharedApproved = await popupTab("mcp-tab-status", userChromeId);
    const sharedGranted = await until(() => bridge.evaluate(sharedTitle).then((result) => result.value, errorCode),
      (value) => value === "Minha aba");
    await popupTab("mcp-tab-unshare", userChromeId);
    await popupTab("mcp-tab-share", userChromeId);
    await bridge.snapshot({ tabId: shared.tabId });
    const reshared = await until(() => bridge.evaluate(sharedTitle).then(() => "allowed", errorCode),
      (value) => value === "ACTION_REQUIRES_CONFIRMATION");
    await popupTab("mcp-tab-unshare", userChromeId);
    report("site approvals", { firstScript, asked: asked.approval, approvedState: approvedState.grants, granted,
      beforeAuto, autoSites: noAutoSites, autoState, automatic, afterTask,
      sharedFirst, sharedApproved: sharedApproved.grants, sharedGranted, reshared });
    if (firstScript !== "ACTION_REQUIRES_CONFIRMATION+siteApproval" || asked.approval !== "execute-script" ||
        JSON.stringify(approvedState.grants) !== '[{"category":"execute-script","until":"task"}]' ||
        granted !== "Minha aba" ||
        beforeAuto !== "ACTION_REQUIRES_CONFIRMATION" || autoState.ok !== false ||
        JSON.stringify(noAutoSites) !== "[]" || automatic !== "ACTION_REQUIRES_CONFIRMATION" ||
        afterTask !== "ACTION_REQUIRES_CONFIRMATION" ||
        sharedFirst !== "ACTION_REQUIRES_CONFIRMATION" ||
        JSON.stringify(sharedApproved.grants) !== '[{"category":"execute-script","until":"tab"}]' ||
        sharedGranted !== "Minha aba" || reshared !== "ACTION_REQUIRES_CONFIRMATION") {
      throw new Error("Site approvals did not follow what the user allowed in Chrome.");
    }

    console.log("\nPERSONAL FRAME SMOKE PASS");
  } finally {
    if (nativeBrowser) {
      await nativeBrowser.close().catch(() => undefined);
    } else await context?.close().catch(() => undefined);
    if (nativeProcess && nativeProcess.exitCode === null && nativeProcess.signalCode === null) {
      const child = nativeProcess;
      child.kill();
      for (let attempt = 0; attempt < 25 && child.exitCode === null && child.signalCode === null; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await bridge.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("PERSONAL FRAME SMOKE FAIL", error);
  process.exitCode = 1;
});
