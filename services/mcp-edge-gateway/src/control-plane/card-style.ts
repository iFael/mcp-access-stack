// What every MCP V3 card in the ChatGPT conversation shares, so they read as
// one set: the colors in light and dark, a header with the title on the left
// and small chips on the right, muted secondary lines and quiet lists.
export const CARD_BASE_CSS = `
  :root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --soft: #f6f8fa; --accent: #0969da; --accent-fg: #ffffff; --good: #1a7f37; --bad: #cf222e; --warn: #9a6700; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #212121; --fg: #ececec; --muted: #a3a3a3; --line: #424242; --soft: #2a2a2a; --accent: #4493f8; --accent-fg: #ffffff; --good: #3fb950; --bad: #ff7b72; --warn: #d29922; } }
  :root[data-theme="dark"] { --bg: #212121; --fg: #ececec; --muted: #a3a3a3; --line: #424242; --soft: #2a2a2a; --accent: #4493f8; --accent-fg: #ffffff; --good: #3fb950; --bad: #ff7b72; --warn: #d29922; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .head h1 { flex: 1; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .chips { display: flex; flex: none; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; background: var(--soft); font-size: 12px; font-weight: 600; white-space: nowrap; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .add { color: var(--good); }
  .del { color: var(--bad); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.good { background: var(--good); }
  .dot.bad { background: var(--bad); }
  .dot.warn { background: var(--warn); }
  section { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 8px; }
  section h2 { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: flex-start; gap: 10px; padding: 3px 0; overflow-wrap: anywhere; }
  .grow { flex: 1; min-width: 0; }
  .num { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
  a, .link { color: var(--accent); text-decoration: none; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
  .muted { color: var(--muted); font-size: 12px; }
  .pin { flex: none; padding: 2px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
  [hidden] { display: none !important; }
`;

/** Follows ChatGPT's theme when it says one; otherwise the system's. */
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

/** The button that pins a card; shown only where ChatGPT can float it. */
export const CARD_PIN_BUTTON = `<button class="pin" id="pin" type="button" title="Manter o cartão visível enquanto a conversa rola" hidden>Fixar</button>`;
