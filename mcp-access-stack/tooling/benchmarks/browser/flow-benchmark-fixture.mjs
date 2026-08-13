import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  LEGACY_LEGACY_SITE_FIXTURE_CONTRACT,
  createLegacyLegacySiteFixtureRouter,
} from "./legacy-private-site-fixture.mjs";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

export async function startFlowBenchmarkFixture(options = {}) {
  const root = path.resolve(
    options.root ??
      path.join(process.cwd(), "services", "browser-worker", "test", "fixtures", "legacy-app"),
  );
  const postCounts = new Map();
  const legacySite = createLegacyLegacySiteFixtureRouter();
  const server = http.createServer(async (request, response) => {
    try {
      const baseUrl = `http://${request.headers.host ?? "127.0.0.1"}`;
      const url = new URL(request.url ?? "/", baseUrl);
      if (legacySite.handle(request, response, url)) return;
      if (url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/flow/post-state") {
        const nonce = requiredNonce(url);
        return json(response, 200, { nonce, postCount: postCounts.get(nonce) ?? 0 });
      }
      if (url.pathname === "/flow/submitted.html" && request.method === "POST") {
        const nonce = requiredNonce(url);
        await readRequestBody(request, 64 * 1_024);
        const postCount = (postCounts.get(nonce) ?? 0) + 1;
        postCounts.set(nonce, postCount);
        return html(response, postbackDocument(nonce, postCount), {
          "cache-control": "no-store",
        });
      }
      if (url.pathname === "/flow/index.html") {
        const nonce = requiredNonce(url);
        return html(response, framesetDocument(nonce, url.searchParams.get("variant") ?? "normal"));
      }
      if (url.pathname === "/flow/menu.html") {
        const nonce = requiredNonce(url);
        return html(response, menuDocument(nonce, url.searchParams.get("variant") ?? "normal"));
      }
      if (url.pathname === "/flow/content.html") {
        const nonce = requiredNonce(url);
        return html(response, contentDocument(nonce));
      }
      if (url.pathname === "/flow/historico.html") {
        const nonce = requiredNonce(url);
        return html(response, historyDocument(nonce));
      }
      if (url.pathname === "/flow/grid.html") {
        const empty = url.searchParams.get("empty") === "1";
        return html(response, gridDocument(empty));
      }
      return await serveStatic(root, url.pathname, response);
    } catch (error) {
      return json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Flow benchmark fixture did not bind to loopback.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    legacyUrl: (nonce, variant = "normal") =>
      `${origin}/flow/index.html?nonce=${encodeURIComponent(nonce)}&variant=${encodeURIComponent(variant)}`,
    segmentedUrl: `${origin}/segmented-index.html`,
    gridUrl: (empty = false) => `${origin}/flow/grid.html?empty=${empty ? "1" : "0"}`,
    legacySiteUrl: (nonce) => legacySite.indexUrl(origin, nonce),
    legacySiteEncodingUrl: (nonce) => legacySite.encodingUrl(origin, nonce),
    legacySiteStateUrl: (nonce) => legacySite.stateUrl(origin, nonce),
    legacySiteContract: LEGACY_LEGACY_SITE_FIXTURE_CONTRACT,
    getLegacySiteRequestCount: (nonce, route) => legacySite.getRequestCount(nonce, route),
    getPostCount: (nonce) => postCounts.get(nonce) ?? 0,
    close: () => closeServer(server),
  };
}

async function serveStatic(root, pathname, response) {
  const relative = pathname.replace(/^\/+/u, "") || "index.html";
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return json(response, 403, { error: "path_outside_fixture" });
  }
  let bytes;
  try {
    bytes = await readFile(absolute);
  } catch {
    return json(response, 404, { error: "not_found" });
  }
  response.writeHead(200, {
    "content-type": CONTENT_TYPES.get(path.extname(absolute).toLocaleLowerCase("en-US")) ??
      "application/octet-stream",
    "cache-control": "no-cache",
  });
  response.end(bytes);
}

function framesetDocument(nonce, variant) {
  const query = `nonce=${encodeURIComponent(nonce)}&variant=${encodeURIComponent(variant)}`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Flow benchmark legacy</title></head>
<frameset cols="280,*">
  <frame id="Menu" name="Menu" src="/flow/menu.html?${query}">
  <frame id="MenuContent" name="MenuContent" src="/flow/content.html?nonce=${encodeURIComponent(nonce)}">
</frameset></html>`;
}

function menuDocument(nonce, variant) {
  const suffix = variant === "poison" ? "-poison" : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Menu</title>
<style>.hidden{display:none}td{padding:6px}</style>
<script>function toggle(id){var e=document.getElementById(id);e.className=e.className==='hidden'?'':'hidden';return false}</script>
</head><body>
<table role="presentation" data-variant="${escapeHtml(variant)}">
  <tr><td><a id="financeiro${suffix}" href="#" onclick="return toggle('financeiro-submenu')">Financeiro</a></td></tr>
  <tr id="financeiro-submenu" class="hidden"><td><table role="presentation">
    <tr><td><a id="cpx-finance${suffix}" href="#" onclick="return toggle('cpx-submenu')">CPX-Finance</a></td></tr>
    <tr id="cpx-submenu" class="hidden"><td>
      <a id="historico${suffix}" href="/flow/historico.html?nonce=${encodeURIComponent(nonce)}" target="MenuContent">Histórico</a>
    </td></tr>
  </table></td></tr>
</table></body></html>`;
}

function contentDocument(nonce) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conteúdo</title>
<script>
function controlledPostback() {
  var request = new XMLHttpRequest();
  request.open('POST', '/flow/submitted.html?nonce=${encodeURIComponent(nonce)}', false);
  request.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
  request.send('query=' + encodeURIComponent(document.getElementById('query').value));
  var nextDocument = request.responseText;
  document.open();
  document.write(nextDocument);
  document.close();
  return false;
}
</script></head><body>
<h1>Conferências</h1>
<form method="post" action="/flow/submitted.html?nonce=${encodeURIComponent(nonce)}" target="MenuContent" onsubmit="return false">
  <label>Pesquisa <input id="query" name="query" type="text"></label>
  <label>Categoria <select id="category" name="category">
    <option value="all">Todas</option><option value="recent">Recentes</option>
  </select></label>
  <button id="confirm-post" type="button" onclick="return controlledPostback()">Confirmar POST</button>
</form></body></html>`;
}

function historyDocument(nonce) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Histórico</title></head><body>
<h1>Histórico</h1><p id="status">Conteúdo carregado no frame de destino.</p>
<a href="/flow/content.html?nonce=${encodeURIComponent(nonce)}" target="MenuContent">Conferências</a>
</body></html>`;
}

function postbackDocument(nonce, postCount) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Documento substituído</title></head><body>
<h1 id="postback-heading">Documento substituído</h1>
<output id="post-count">${postCount}</output>
<code id="post-nonce">${escapeHtml(nonce)}</code>
</body></html>`;
}

function gridDocument(empty) {
  const rows = empty
    ? ""
    : Array.from({ length: 20 }, (_, index) =>
      `<tr><td>${index + 1}</td><td>Conta ${String(index + 1).padStart(2, "0")}</td><td>${1000 + index}</td></tr>`
    ).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Grade segura</title></head><body>
<h1>Resultados</h1>
${empty ? '<p id="empty-state">Nenhum registro encontrado.</p>' : `<table id="results"><thead><tr><th>Índice</th><th>Conta</th><th>Valor</th></tr></thead><tbody>${rows}</tbody></table>`}
</body></html>`;
}

function requiredNonce(url) {
  const nonce = url.searchParams.get("nonce");
  if (!nonce || !/^[A-Za-z0-9_-]{1,128}$/u.test(nonce)) {
    throw new Error("A valid fixture nonce is required.");
  }
  return nonce;
}

function readRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error("Fixture POST body exceeds the benchmark limit."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function html(response, body, headers = {}) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    ...headers,
  });
  response.end(body);
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}
