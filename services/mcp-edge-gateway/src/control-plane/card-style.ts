// Minimal MCP Apps JSON-RPC bridge, shared by all three self-contained HTML cards.
// No external scripts: the resource is sandboxed and must work without network access.
// window.openai remains available for hosts using the older ChatGPT widget bridge.
export const CARD_MCP_APPS_SCRIPT = `
(function () {
  var nextId = 0;
  var pending = new Map();
  var nativeReady = false;
  var nativeInput = null;
  var nativeOutput = null;
  var hostContext = {};
  function post(message) { window.parent.postMessage(message, "*"); }
  function note(state) {
    if (window.console && typeof window.console.info === "function") window.console.info("[mcp-v3-card] " + state);
  }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = "mcp-v3-card-" + (++nextId);
      var waiting = { resolve: resolve, reject: reject };
      var message = { jsonrpc: "2.0", id: id, method: method, params: params };
      pending.set(id, waiting);
      post(message);
      if (method === "ui/initialize") {
        note("init-sent");
        // A dynamically loaded iframe may post before the host starts listening.
        // Retry only this idempotent handshake, not tool calls or mutations.
        [200, 600, 1200, 2200].forEach(function (delay) {
          window.setTimeout(function () {
            if (pending.get(id) === waiting) {
              if (delay === 2200) note("init-retry-final");
              post(message);
            }
          }, delay);
        });
      }
    });
  }
  function legacy() { return window.openai || {}; }
  function changed() { window.dispatchEvent(new Event("openai:set_globals")); }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (typeof message.id === "string" && pending.has(message.id)) {
      var waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || "MCP Apps request failed"));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-input") {
      nativeInput = message.params && message.params.arguments || null;
      changed();
    } else if (message.method === "ui/notifications/tool-result") {
      nativeOutput = message.params && message.params.structuredContent || null;
      changed();
    } else if (message.method === "ui/notifications/host-context-changed") {
      Object.assign(hostContext, message.params || {});
      changed();
    }
  });
  window.mcpV3Card = {
    get toolInput() { return nativeInput || legacy().toolInput || {}; },
    get toolOutput() { return nativeOutput || legacy().toolOutput || {}; },
    get theme() { return hostContext.theme || legacy().theme; },
    get widgetState() { return legacy().widgetState; },
    get displayMode() { return hostContext.displayMode || legacy().displayMode; },
    setWidgetState: function (value) {
      if (typeof legacy().setWidgetState === "function") return legacy().setWidgetState(value);
    },
    callTool: function (name, args) {
      if (nativeReady) return request("tools/call", { name: name, arguments: args });
      if (typeof legacy().callTool === "function") return legacy().callTool(name, args);
      return Promise.reject(new Error("MCP Apps host is not ready"));
    },
    openExternal: function (options) {
      if (nativeReady) return request("ui/open-link", { url: options.href });
      if (typeof legacy().openExternal === "function") return legacy().openExternal(options);
      return window.open(options.href, "_blank", "noopener");
    },
    requestDisplayMode: function (options) {
      if (nativeReady) return request("ui/request-display-mode", options);
      if (typeof legacy().requestDisplayMode === "function") return legacy().requestDisplayMode(options);
      return Promise.reject(new Error("MCP Apps host is not ready"));
    },
    notifyIntrinsicHeight: function (height) {
      if (typeof legacy().notifyIntrinsicHeight === "function") legacy().notifyIntrinsicHeight(height);
    }
  };
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "mcp-v3-card", version: "1.0.0" },
    appCapabilities: {}
  }).then(function (result) {
    hostContext = result && result.hostContext || {};
    nativeReady = true;
    note("init-acknowledged");
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    changed();
  }).catch(function () {
    // Older hosts still supply window.openai. They do not implement ui/initialize.
    changed();
  });
})();
`;

// What every MCP V3 card in the ChatGPT conversation shares, so they read as
// one set: the colors in light and dark, a header with the title on the left
// and small chips on the right, muted secondary lines and quiet lists.
export const CARD_BASE_CSS = `
  :root { --bg: #ffffff; --fg: #0d0d0d; --muted: #6b6b6b; --line: rgba(0, 0, 0, .09); --soft: #f4f4f4; --accent: #2f6fdb; --accent-fg: #ffffff;
    --good: #12805c; --bad: #d93025; --warn: #b26b00; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #212121; --fg: #ececec; --muted: #a0a0a0; --line: rgba(255, 255, 255, .1);
    --soft: #2f2f2f; --accent: #6aa6ff; --accent-fg: #0d0d0d; --good: #3ecf8e; --bad: #ff6b6b; --warn: #e3a33b; } }
  :root[data-theme="dark"] { --bg: #212121; --fg: #ececec; --muted: #a0a0a0; --line: rgba(255, 255, 255, .1);
    --soft: #2f2f2f; --accent: #6aa6ff; --accent-fg: #0d0d0d; --good: #3ecf8e; --bad: #ff6b6b; --warn: #e3a33b; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .head h1 { flex: 1; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .chips { display: flex; flex: none; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: var(--soft);
    font-size: 12px; font-weight: 500; white-space: nowrap; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 12px; overflow-wrap: anywhere; }
  .add { color: var(--good); }
  .del { color: var(--bad); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.good { background: var(--good); }
  .dot.bad { background: var(--bad); }
  .dot.warn { background: var(--warn); }
  section { margin-top: 14px; }
  section h2 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; overflow-wrap: anywhere; }
  .grow { flex: 1; min-width: 0; }
  .num { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  a, .link { color: var(--accent); text-decoration: none; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
  a:hover, .link:hover { text-decoration: underline; }
  .muted { color: var(--muted); font-size: 12px; }
  /* Actions: rounded pills, as ChatGPT draws them. */
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px;
    background: transparent; color: var(--fg); font: inherit; cursor: pointer; transition: background .15s, border-color .15s; }
  .btn:hover:not(:disabled) { background: var(--soft); }
  .btn:disabled { cursor: default; }
  .btn.primary { border-color: transparent; background: var(--fg); color: var(--bg); font-weight: 500; }
  [hidden] { display: none !important; }
`;

/** Follows ChatGPT's theme when it says one; otherwise the system's. */
// ChatGPT gives a card a fixed height unless the card says how tall it is, which left
// a large empty box under a short card. It is told again whenever the content changes.
export const CARD_FIT_SCRIPT = `
(function () {
  var last = 0;
  var told = false;
  function fit() {
    var height = Math.ceil(document.body.getBoundingClientRect().height);
    // A card ChatGPT hides for a moment measures 0; told so, ChatGPT would keep it at 0.
    if (height < 1) return;
    var api = window.mcpV3Card || window.openai;
    var bridge = api && typeof api.notifyIntrinsicHeight === "function";
    // ChatGPT can hand the card its bridge after the first look, so it is told again then.
    if (height === last && (told || !bridge)) return;
    last = height;
    try { if (bridge) { api.notifyIntrinsicHeight(height); told = true; } } catch (e) {}
    try { window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: height } }, "*"); } catch (e) {}
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(document.body);
  window.addEventListener("load", fit);
  window.addEventListener("openai:set_globals", fit);
  [0, 300, 1000, 3000].forEach(function (ms) { setTimeout(fit, ms); });
})();
`;

export const CARD_THEME_SCRIPT = `
  function applyTheme() {
    var api = window.mcpV3Card || window.openai;
    var theme = api && api.theme;
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
    var pin = document.getElementById("pin");
    if (pin) {
      var bridge = window.mcpV3Card || window.openai;
      pin.hidden = !bridge || typeof bridge.requestDisplayMode !== "function";
      pin.textContent = bridge && bridge.displayMode === "pip" ? "Soltar" : "Fixar";
    }
  }
  // Fixar keeps the card floating at the top of the chat while it scrolls (ChatGPT's picture-in-picture).
  document.addEventListener("click", function (event) {
    if (!event.target || event.target.id !== "pin") return;
    var bridge = window.mcpV3Card || window.openai;
    if (!bridge || typeof bridge.requestDisplayMode !== "function") return;
    Promise.resolve(bridge.requestDisplayMode({ mode: bridge.displayMode === "pip" ? "inline" : "pip" }))
      .then(applyTheme, applyTheme);
  });
`;
