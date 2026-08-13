import { Buffer } from "node:buffer";

export const LEGACY_LEGACY_SITE_FIXTURE_CONTRACT = Object.freeze({
  frames: Object.freeze({
    menu: "Menu",
    content: "MenuContent",
    detail: "DetailPane",
  }),
  menu: Object.freeze({
    rootSelector: "#MainMenu_1",
    homeSelector: "#home-link",
    financeCollapsedRootSelector: "#Plus101",
    financeExpandedRootSelector: "#Minus101",
    financeClickSelector: "#Plus101 > table",
    financeExpandedClickSelector: "#Minus101 > table",
    cpxOpenedRootSelector: "#DataOpenned102",
    cpxVisibleRootSelector: "#DataOpenned102 font",
    cpxClickSelector: "#anchor_102_2",
    encodingSelector: "#anchor_103_2",
  }),
  content: Object.freeze({
    headerSelector: ".finc-fila-head",
    filterIds: Object.freeze(["IN2", "IN3", "IN4", "IN5"]),
    panelSelector: ".finc-fila-view-tab",
    activePanelSelector: ".finc-fila-view-tab.is-active",
    refreshSelector: ".finc-fila-filter-refresh",
    loadCountSelector: ".finc-fila-load-count",
    tableSelector: ".finc-fila-table",
  }),
  delays: Object.freeze({
    menuExpansionMs: 80,
    contentDispatchMs: 50,
    contentReplacementMs: 140,
    panelSwitchMs: 90,
    gridLoadMs: 110,
    detailFrameMs: 120,
  }),
  encoding: Object.freeze({
    charset: "windows-1252",
    expectedText: "Conferências | Histórico | Descrição | Situação | Ação",
  }),
});

export function createLegacyLegacySiteFixtureRouter() {
  const requestCounts = new Map();

  return {
    handle(request, response, url) {
      if (!url.pathname.startsWith("/legacySite/")) return false;
      const nonce = requiredNonce(url);

      if (url.pathname === "/legacySite/state") {
        return json(response, 200, {
          nonce,
          requests: requestCountSnapshot(requestCounts, nonce),
        });
      }
      if (url.pathname === "/legacySite/index.html") {
        countRequest(requestCounts, nonce, "index");
        return html(response, framesetDocument(nonce));
      }
      if (url.pathname === "/legacySite/menu.html") {
        countRequest(requestCounts, nonce, "menu");
        return html(response, menuDocument(nonce));
      }
      if (url.pathname === "/legacySite/home.html") {
        countRequest(requestCounts, nonce, "home");
        return html(response, homeDocument());
      }
      if (url.pathname === "/legacySite/loading.html") {
        countRequest(requestCounts, nonce, "loading");
        return html(response, loadingDocument(nonce), { "cache-control": "no-store" });
      }
      if (url.pathname === "/legacySite/cpx-finance.html") {
        countRequest(requestCounts, nonce, "cpx-finance");
        return html(response, cpxFinanceDocument(nonce), { "cache-control": "no-store" });
      }
      if (url.pathname === "/legacySite/detail.html") {
        countRequest(requestCounts, nonce, "detail");
        return html(response, detailDocument());
      }
      if (url.pathname === "/legacySite/encoding.html") {
        countRequest(requestCounts, nonce, "encoding");
        return windows1252Html(response, encodingDocument());
      }
      return json(response, 404, { error: "legacySite_fixture_not_found" });
    },
    indexUrl(origin, nonce) {
      return `${origin}/legacySite/index.html?nonce=${encodeURIComponent(validateNonce(nonce))}`;
    },
    encodingUrl(origin, nonce) {
      return `${origin}/legacySite/encoding.html?nonce=${encodeURIComponent(validateNonce(nonce))}`;
    },
    stateUrl(origin, nonce) {
      return `${origin}/legacySite/state?nonce=${encodeURIComponent(validateNonce(nonce))}`;
    },
    getRequestCount(nonce, route) {
      return requestCounts.get(requestKey(validateNonce(nonce), route)) ?? 0;
    },
  };
}

function framesetDocument(nonce) {
  const encoded = encodeURIComponent(nonce);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>LegacySite legacy fixture</title></head>
<frameset cols="275,*">
  <frame id="Menu" name="Menu" src="/legacySite/menu.html?nonce=${encoded}">
  <frame id="MenuContent" name="MenuContent" src="/legacySite/home.html?nonce=${encoded}">
  <noframes><body>Frames are required.</body></noframes>
</frameset></html>`;
}

function menuDocument(nonce) {
  const encoded = encodeURIComponent(nonce);
  const delay = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.menuExpansionMs;
  const dispatch = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.contentDispatchMs;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Menu legado</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px}.legacy-hidden{display:none}table{cursor:pointer;border-collapse:collapse}td{padding:3px 5px}
</style>
<script>
function setFinanceExpanded(expanded) {
  document.getElementById('Plus101').style.display = expanded ? 'none' : 'block';
  document.getElementById('Minus101').style.display = expanded ? 'block' : 'none';
  document.getElementById('DataOpenned102').style.display = expanded ? 'block' : 'none';
  document.getElementById('DataOpenned103').style.display = expanded ? 'block' : 'none';
  document.body.dataset.menuState = expanded ? 'expanded' : 'collapsed';
}
function expandFinance() {
  document.body.dataset.menuTransition = 'expanding';
  setTimeout(function () {
    setFinanceExpanded(true);
    document.body.dataset.menuTransition = 'idle';
  }, ${delay});
  return false;
}
function collapseFinance() {
  document.body.dataset.menuTransition = 'collapsing';
  setTimeout(function () {
    setFinanceExpanded(false);
    document.body.dataset.menuTransition = 'idle';
  }, ${delay});
  return false;
}
function openCpxFinance() {
  document.body.dataset.contentNavigation = 'scheduled';
  setTimeout(function () {
    parent.frames['MenuContent'].location.href = '/legacySite/loading.html?nonce=${encoded}';
    document.body.dataset.contentNavigation = 'dispatched';
  }, ${dispatch});
  return false;
}
</script></head>
<body data-menu-state="collapsed" data-menu-transition="idle" data-content-navigation="idle">
<div id="MainMenu_1">
  <div id="HomeRoot">
    <table><tr><td><font><a id="home-link" href="/legacySite/home.html?nonce=${encoded}" target="MenuContent">Novidades (Home)</a></font></td></tr></table>
  </div>
  <div id="Plus101">
    <table onclick="return expandFinance()"><tr><td><font>Financeiro</font></td></tr></table>
  </div>
  <div id="Minus101" style="display:none">
    <table onclick="return collapseFinance()"><tr><td><font>Financeiro</font></td></tr></table>
  </div>
  <div id="Div101">
    <div id="DataOpenned102" style="display:none">
      <font><a id="anchor_102_2" href="#" onclick="return openCpxFinance()">CPX-Finance</a></font>
    </div>
    <div id="DataOpenned103" style="display:none">
      <font><a id="anchor_103_2" href="/legacySite/encoding.html?nonce=${encoded}" target="MenuContent">Relatório ANSI</a></font>
    </div>
  </div>
</div>
</body></html>`;
}

function homeDocument() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Novidades</title></head><body>
<h1 id="home-heading">Novidades (Home)</h1>
<p id="home-state">Estado inicial seguro do fixture.</p>
</body></html>`;
}

function loadingDocument(nonce) {
  const encoded = encodeURIComponent(nonce);
  const delay = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.contentReplacementMs;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Carregando CPX-Finance</title></head><body data-stage="loading">
<p id="legacy-loading">Carregando módulo...</p>
<script>
setTimeout(function () {
  location.replace('/legacySite/cpx-finance.html?nonce=${encoded}');
}, ${delay});
</script>
</body></html>`;
}

function cpxFinanceDocument(nonce) {
  const encoded = encodeURIComponent(nonce);
  const panelDelay = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.panelSwitchMs;
  const gridDelay = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.gridLoadMs;
  const detailDelay = LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.delays.detailFrameMs;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>CPX-Finance fixture</title>
<style>
  .finc-fila-view{display:none}.finc-fila-view.is-active{display:block}.finc-fila-view-tab.is-active{font-weight:bold}.fixture-grid{margin-top:8px}
</style>
<script>
function setPanel(view) {
  document.body.dataset.pendingView = view;
  setTimeout(function () {
    document.querySelectorAll('.finc-fila-view-tab').forEach(function (button) {
      button.classList.toggle('is-active', button.dataset.view === view);
    });
    document.querySelectorAll('.finc-fila-view').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.dataset.view === view);
    });
    document.body.dataset.activeView = view;
    document.body.dataset.pendingView = '';
  }, ${panelDelay});
  return false;
}
function recordFocus(element) {
  document.body.dataset.focusedControl = element.id;
  document.getElementById('focus-state').textContent = element.id;
}
function recordSelection(select) {
  document.body.dataset.selectedStatus = select.value;
  document.getElementById('selection-state').textContent = select.value;
}
function recordKey(event) {
  if (event.key !== 'Enter') return;
  document.body.dataset.lastKey = event.key;
  document.getElementById('keyboard-state').textContent = event.key;
}
function refreshGrid() {
  document.body.dataset.gridState = 'loading';
  document.querySelector('.finc-fila-load-count').textContent = 'Carregando...';
  document.getElementById('results-shell').innerHTML = '';
  setTimeout(function () {
    document.getElementById('results-shell').innerHTML = '<table class="finc-fila-table fixture-grid"><thead><tr><th>Conta</th><th>Situação</th></tr></thead><tbody><tr><td>Conta A</td><td>Pendente</td></tr><tr><td>Conta B</td><td>Conferida</td></tr></tbody></table>';
    document.querySelector('.finc-fila-load-count').textContent = '2 lançamentos';
    document.body.dataset.gridState = 'ready';
  }, ${gridDelay});
  return false;
}
window.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    var frame = document.createElement('iframe');
    frame.id = 'detail-frame';
    frame.name = 'DetailPane';
    frame.src = '/legacySite/detail.html?nonce=${encoded}';
    document.getElementById('detail-shell').appendChild(frame);
    document.body.dataset.detailState = 'ready';
  }, ${detailDelay});
});
</script></head>
<body data-active-view="conferencias" data-pending-view="" data-grid-state="idle" data-detail-state="pending">
<header class="finc-fila-head"><h1>CPX-Finance</h1></header>
<nav>
  <button type="button" class="finc-fila-view-tab is-active" data-view="conferencias" onclick="return setPanel('conferencias')">Conferências</button>
  <button type="button" class="finc-fila-view-tab" data-view="historico" onclick="return setPanel('historico')">Histórico</button>
</nav>
<section class="finc-fila-view is-active" data-view="conferencias">
  <label>Empresa <input id="IN2" onfocus="recordFocus(this)" onkeydown="recordKey(event)"></label>
  <label>Conta <input id="IN3" onfocus="recordFocus(this)"></label>
  <label>Data inicial <input id="IN4" onfocus="recordFocus(this)"></label>
  <label>Data final <input id="IN5" onfocus="recordFocus(this)"></label>
  <label>Situação
    <select id="legacy-status" onchange="recordSelection(this)">
      <option value="all">Todas</option>
      <option value="pending">Pendentes</option>
      <option value="checked">Conferidas</option>
    </select>
  </label>
  <button type="button" class="finc-fila-filter-refresh" onclick="return refreshGrid()">Atualizar</button>
  <output class="finc-fila-load-count">Aguardando consulta</output>
  <output id="focus-state"></output>
  <output id="selection-state"></output>
  <output id="keyboard-state"></output>
  <div id="results-shell"></div>
</section>
<section class="finc-fila-view" data-view="historico"><p>Histórico local determinístico.</p></section>
<div id="detail-shell"></div>
</body></html>`;
}

function detailDocument() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Detalhes</title></head><body>
<p id="detail-ready">Detalhes carregados.</p>
</body></html>`;
}

function encodingDocument() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>Relatório ANSI</title></head><body>
<h1>Relatório ANSI</h1>
<p id="encoded-text">${LEGACY_LEGACY_SITE_FIXTURE_CONTRACT.encoding.expectedText}</p>
</body></html>`;
}

function requiredNonce(url) {
  return validateNonce(url.searchParams.get("nonce"));
}

function validateNonce(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("A valid LegacySite fixture nonce is required.");
  }
  return value;
}

function countRequest(requestCounts, nonce, route) {
  const key = requestKey(nonce, route);
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

function requestCountSnapshot(requestCounts, nonce) {
  return Object.fromEntries(
    ["index", "menu", "home", "loading", "cpx-finance", "detail", "encoding"]
      .map((route) => [route, requestCounts.get(requestKey(nonce, route)) ?? 0]),
  );
}

function requestKey(nonce, route) {
  return `${nonce}\u0000${String(route)}`;
}

function html(response, body, headers = {}) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    ...headers,
  });
  response.end(body);
  return true;
}

function windows1252Html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=windows-1252",
    "cache-control": "no-store",
  });
  response.end(Buffer.from(body, "latin1"));
  return true;
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
  return true;
}
