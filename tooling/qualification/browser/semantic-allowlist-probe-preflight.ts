import { chromium } from "playwright";

const probe = `(() => {
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ').trim();
  const mutation = /\\b(delete|remove|cancel|excluir|remover|buy|pay|comprar|pagar|send|enviar|publish|publicar|password|senha|upload|attach|anexar|submit|save|confirm|create|update|salvar|confirmar)\\b/;
  const query = /\\b(refresh|search|query|filter|view|history|atualizar|consultar|pesquisar|buscar|filtrar|historico|financeiro|cpx-finance|home)\\b/;
  const category = (element) => {
    const text = normalize([element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('name'), element.id, element.className, element.textContent, element.value].join(' '));
    if (mutation.test(text)) return 'mutation';
    if (query.test(text)) return 'query';
    return 'unknown';
  };
  const locationOf = (value) => {
    const url = new URL(value || location.href, location.href);
    return { path: url.pathname, queryKeys: [...new Set([...url.searchParams.keys()])].sort() };
  };
  const interactive = [...document.querySelectorAll('a[href],button,input[type=button],input[type=submit],input[type=image],select')]
    .filter((element) => !element.closest('table,[role=grid],.finc-fila-table'));
  const categories = interactive.map(category);
  const routes = [...document.querySelectorAll('a[href]')]
    .filter((element) => !element.closest('table,[role=grid],.finc-fila-table'))
    .map((element) => ({ ...locationOf(element.href), category: category(element) }));
  return {
    formCount: document.forms.length,
    queryControlCount: categories.filter((value) => value === 'query').length,
    mutationControlCount: categories.filter((value) => value === 'mutation').length,
    fileInputCount: document.querySelectorAll('input[type=file]').length,
    routes,
  };
})()`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><base href="https://dev-private.example.test/"></head><body>
    <form method="post" action="/LegacySite.asp?acao=consulta&token=ignored">
      <input type="text" value="private-fixture-value">
      <button class="finc-fila-filter-refresh">Atualizar</button>
      <button id="save-record">Salvar</button>
      <input type="file">
    </form>
    <a href="/consulta.asp?conta=123&pagina=1">Consultar</a>
    <table><tr><td><a href="/registro/123456">Registro 123456</a></td></tr></table>
  </body></html>`);
  const result = await page.mainFrame().evaluate(probe) as {
    formCount: number;
    queryControlCount: number;
    mutationControlCount: number;
    fileInputCount: number;
    routes: Array<{ path: string; queryKeys: string[]; category: string }>;
  };
  const serialized = JSON.stringify(result);
  if (
    result.formCount !== 1 ||
    result.queryControlCount < 1 ||
    result.mutationControlCount < 1 ||
    result.fileInputCount !== 1 ||
    result.routes.length !== 1 ||
    result.routes[0]?.path !== "/consulta.asp" ||
    serialized.includes("private-fixture-value") ||
    serialized.includes("123456")
  ) {
    throw new Error("Semantic allowlist DOM probe preflight failed.");
  }
  process.stdout.write(JSON.stringify({
    passed: true,
    formCount: result.formCount,
    queryControlCount: result.queryControlCount,
    mutationControlCount: result.mutationControlCount,
    fileInputCount: result.fileInputCount,
    routeCount: result.routes.length,
    sensitiveValuesRetained: false,
  }, null, 2) + "\n");
} finally {
  await browser.close();
}
