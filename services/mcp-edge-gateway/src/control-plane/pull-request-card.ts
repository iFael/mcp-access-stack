// The card ChatGPT shows with github_get_pull_request: the pull request at a
// glance, like the bar of a code review tool. Number, title and state, the
// branches, lines added and removed, the files it changes and how its CI is
// doing. Links open the pull request on GitHub.

import { CARD_BASE_CSS, CARD_FIT_SCRIPT, CARD_THEME_SCRIPT } from "./card-style.js";
import type { EdgeUiResource } from "./user-messages-card.js";

export const PULL_REQUEST_CARD_URI = "ui://mcp-v3/pull-request-v4.html";

export const PULL_REQUEST_CARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CARD_BASE_CSS}
  .file { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .file .grow { overflow-wrap: anywhere; }
  .more { margin-top: 4px; }
</style>
</head>
<body>
<div class="head">
  <h1 id="title">Pull request</h1>
  <div class="chips">
    <span class="chip" id="size" hidden><span class="add" id="adds"></span><span class="del" id="dels"></span></span>
    <span class="chip" id="ci" hidden><span class="dot" id="ci-dot"></span>CI</span>
  </div>
</div>
<div class="sub" id="sub"></div>
<section id="checks" hidden>
  <h2>CI</h2>
  <ul id="check-rows"></ul>
</section>
<section id="files" hidden>
  <h2 id="files-title">Arquivos</h2>
  <ul id="file-rows"></ul>
  <button class="link more" id="more" type="button" hidden></button>
</section>
<section>
  <button class="btn" id="open" type="button">Abrir no GitHub</button>
</section>
<script>
(function () {
  ${CARD_THEME_SCRIPT}
  var SHOWN = 8;
  var expanded = false;
  function open(href) {
    var bridge = window.openai;
    if (bridge && typeof bridge.openExternal === "function") bridge.openExternal({ href: href });
    else window.open(href, "_blank", "noopener");
  }
  function row(list, dotClass, label, count, extra) {
    var li = document.createElement("li");
    var dot = document.createElement("span");
    dot.className = "dot " + dotClass;
    dot.style.marginTop = "7px";
    var text = document.createElement("span");
    text.className = "grow";
    text.textContent = label;
    if (extra) {
      var small = document.createElement("div");
      small.className = "muted";
      small.textContent = extra;
      text.appendChild(small);
    }
    var num = document.createElement("span");
    num.className = "num";
    num.textContent = String(count);
    li.appendChild(dot); li.appendChild(text); li.appendChild(num);
    list.appendChild(li);
  }
  function render() {
    applyTheme();
    var pr = (window.openai && window.openai.toolOutput) || {};
    if (typeof pr.number !== "number") return;
    var o = pr.overview || null;
    document.getElementById("title").textContent = "#" + pr.number + " " + (pr.title || "");
    var state = pr.merged ? "Mesclada" : pr.state === "closed" ? "Fechada" : o && o.draft ? "Rascunho" : "Aberta";
    document.getElementById("sub").textContent = o ? state + " · " + o.headRef + " → " + o.baseRef : state;
    var size = document.getElementById("size");
    size.hidden = !o;
    if (o) {
      document.getElementById("adds").textContent = "+" + o.additions;
      document.getElementById("dels").textContent = "−" + o.deletions;
    }
    var c = o && o.checks;
    document.getElementById("ci").hidden = !c;
    document.getElementById("checks").hidden = !c;
    if (c) {
      document.getElementById("ci-dot").className = "dot " + (c.failed > 0 ? "bad" : c.pending > 0 ? "warn" : "good");
      var rows = document.getElementById("check-rows");
      rows.textContent = "";
      if (c.failed > 0) row(rows, "bad", "Falhou", c.failed, (c.failing || []).join(", "));
      row(rows, "warn", "Em andamento", c.pending);
      row(rows, "good", "Aprovado", c.passed);
      row(rows, "", "Ignorado", c.skipped);
    }
    var files = o && Array.isArray(o.files) ? o.files : null;
    document.getElementById("files").hidden = !files;
    if (files) {
      document.getElementById("files-title").textContent = "Arquivos (" + o.changedFiles + ")";
      var list = document.getElementById("file-rows");
      list.textContent = "";
      files.slice(0, expanded ? files.length : SHOWN).forEach(function (file) {
        var li = document.createElement("li");
        li.className = "file";
        var name = document.createElement("button");
        name.type = "button";
        name.className = "link grow";
        name.style.textAlign = "left";
        name.textContent = file.path;
        name.title = "Ver as alterações no GitHub";
        name.addEventListener("click", function () { open(pr.url + "/files"); });
        var counts = document.createElement("span");
        counts.className = "num";
        counts.innerHTML = '<span class="add"></span> <span class="del"></span>';
        counts.firstChild.textContent = "+" + file.additions;
        counts.lastChild.textContent = "−" + file.deletions;
        li.appendChild(name); li.appendChild(counts);
        list.appendChild(li);
      });
      var more = document.getElementById("more");
      var hiddenCount = Math.max(0, o.changedFiles - SHOWN);
      more.hidden = expanded || files.length <= SHOWN;
      more.textContent = "Mostrar mais " + hiddenCount;
    }
  }
  document.getElementById("more").addEventListener("click", function () { expanded = true; render(); });
  document.getElementById("open").addEventListener("click", function () {
    var pr = (window.openai && window.openai.toolOutput) || {};
    if (typeof pr.url === "string") open(pr.url);
  });
  window.addEventListener("openai:set_globals", render);
  render();
})();
</script>
<script>${CARD_FIT_SCRIPT}</script>
</body>
</html>
`;

export const PULL_REQUEST_CARD_RESOURCE: EdgeUiResource = {
  uri: PULL_REQUEST_CARD_URI,
  name: "Pull request",
  description: "Shows a pull request at a glance: state, branches, lines changed, files and CI.",
  mimeType: "text/html;profile=mcp-app",
  text: PULL_REQUEST_CARD_HTML,
  _meta: {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": "The pull request's state, size, files and CI, with a link to GitHub.",
  },
};
