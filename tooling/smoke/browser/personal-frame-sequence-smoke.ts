// Real-Chromium smoke for the personal Chrome extension: loads the generated
// extension into a throwaway Playwright Chromium profile (never a personal
// profile), serves nested cross-site frames from loopback under *.test names,
// and drives legacy frame mutations plus plain ref actions through the bridge.
// Run: npm run smoke:browser:personal-frames
// PERSONAL_SMOKE_CHROMIUM overrides the Chromium executable when needed.
// PERSONAL_SMOKE_HEADFUL=1 uses a real window (e.g. under xvfb-run), which
// shows Chrome's debugging infobar and the OS drag loop like a personal Chrome.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import { PersonalBrowserBridge } from "../../../services/mcp-gateway/src/companion/personal-browser-bridge.js";

const submissions: string[] = [];
const listHits: string[] = [];
const pages: Record<string, (url: URL, port: number) => string> = {
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
      <input id="busca" onkeydown="if(event.key==='Enter'){document.getElementById('ok').textContent='Enter recebido: '+this.value}">`;
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
    <p id="out">vazio</p><p id="again">nada</p>
    <script>
      const zone = document.getElementById("zone");
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", async (event) => {
        event.preventDefault();
        globalThis.dropped = event.dataTransfer.files[0];
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
    <p id="status">pendente</p>
    <div id="knob" role="slider" aria-label="Alça" aria-valuenow="0" style="position:absolute;left:300px;top:20px;width:30px;height:30px;background:#88f"></div>
    <p id="pointer">parado</p>
    <script>
      let dragging = false;
      document.getElementById("knob").addEventListener("mousedown", () => { dragging = true; });
      document.addEventListener("mouseup", (event) => {
        if (!dragging) return;
        dragging = false;
        const zone = document.getElementById("done").getBoundingClientRect();
        const inside = event.clientX >= zone.left && event.clientX <= zone.right && event.clientY >= zone.top && event.clientY <= zone.bottom;
        document.getElementById("pointer").textContent = inside ? "solto na coluna" : "fora";
      });
      document.getElementById("card").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "card"));
      const done = document.getElementById("done");
      done.addEventListener("dragover", (event) => event.preventDefault());
      done.addEventListener("drop", (event) => {
        event.preventDefault();
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
  "plain-site.test/": () => `<!doctype html><title>Plain</title><body>
    <button onclick="document.getElementById('out').textContent='Mostrado'">Mostrar detalhes</button>
    <p id="out">Oculto</p>`,
};

function report(label: string, value: unknown): void {
  console.log(`\n== ${label}\n${JSON.stringify(value, null, 1).slice(0, 2500)}`);
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
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
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
  const bridge = await PersonalBrowserBridge.start({
    stateRoot: root, port: 34_000 + Math.floor(Math.random() * 1_000),
  });
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(path.join(root, "profile"), {
      channel: "chromium",
      headless: process.env.PERSONAL_SMOKE_HEADFUL !== "1",
      // No Playwright viewport emulation: page size follows the real window, as in a personal Chrome.
      viewport: null,
      ...(process.env.PERSONAL_SMOKE_CHROMIUM ? { executablePath: process.env.PERSONAL_SMOKE_CHROMIUM } : {}),
      args: [
        `--disable-extensions-except=${bridge.extensionDirectory}`,
        `--load-extension=${bridge.extensionDirectory}`,
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        "--no-proxy-server",
        "--site-per-process",
        "--window-size=1280,900",
      ],
    });
    for (let attempt = 0; attempt < 100 && !bridge.isConnected(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!bridge.isConnected()) throw new Error("The generated extension did not connect to the bridge.");
    report("connection", { ...bridge.connectionInfo(), capabilities: undefined });

    const opened = await bridge.open({ url: `http://parent-site.test:${sitePort}/`, taskId: "personal-frame-smoke" });
    const tabId = opened.tab.tabId;
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
    if (submissions.length) throw new Error("The form was submitted before confirmation.");
    const saved = await bridge.frameSequence!({ tabId, timeoutMs: 60_000,
      steps: steps.map((step) => (step.action === "click" ? { ...step, confirmationId } : step)) });
    report("nested OOPIF fill/select/click", saved);
    if (submissions.length !== 1 || !submissions[0]!.includes("nome=Maria") || !submissions[0]!.includes("uf=mg")) {
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
      steps: enterSteps.map((step) => (step.action === "press" ? { ...step, confirmationId: enterId } : step)) });
    report("nested OOPIF Enter", entered);
    if (!JSON.stringify(entered.steps.at(-1)).includes("Enter recebido: pedido 42")) {
      throw new Error("Enter did not reach the nested field.");
    }

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
    let pathConfirmation = "";
    try {
      await bridge.navigatePath!(danger);
      throw new Error("A dangerous menu label ran without confirmation.");
    } catch (error) {
      pathConfirmation = confirmationIdOf(error);
    }
    const deleted = await bridge.navigatePath!({ ...danger, confirmationId: pathConfirmation });
    report("confirmed dangerous menu path", deleted.checkpoint);
    if (deleted.checkpoint?.step.value !== "apagado") throw new Error("Confirmed menu path did not run.");

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
    const zoomedSize = jpegSize(await readFile(zoomed.path));
    report("zoomed region", zoomedSize);
    if (zoomedSize.width !== 400 || zoomedSize.height !== 160) throw new Error("Zoomed region has the wrong resolution.");

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
    console.log("\nPERSONAL FRAME SMOKE PASS");
  } finally {
    await context?.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("PERSONAL FRAME SMOKE FAIL", error);
  process.exitCode = 1;
});
