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
    var bridge = window.openai && typeof window.openai.notifyIntrinsicHeight === "function";
    // ChatGPT can hand the card its bridge after the first look, so it is told again then.
    if (height === last && (told || !bridge)) return;
    last = height;
    try { if (bridge) { window.openai.notifyIntrinsicHeight(height); told = true; } } catch (e) {}
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
    var theme = window.openai && window.openai.theme;
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
    var pin = document.getElementById("pin");
    if (pin) {
      var bridge = window.openai;
      pin.hidden = !bridge || typeof bridge.requestDisplayMode !== "function";
      pin.textContent = bridge && bridge.displayMode === "pip" ? "Soltar" : "Fixar";
    }
  }
  // Fixar keeps the card floating at the top of the chat while it scrolls (ChatGPT's picture-in-picture).
  document.addEventListener("click", function (event) {
    if (!event.target || event.target.id !== "pin") return;
    var bridge = window.openai;
    if (!bridge || typeof bridge.requestDisplayMode !== "function") return;
    Promise.resolve(bridge.requestDisplayMode({ mode: bridge.displayMode === "pip" ? "inline" : "pip" }))
      .then(applyTheme, applyTheme);
  });
`;
