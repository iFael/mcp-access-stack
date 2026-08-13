# Benchmarks

Ferramentas de medição isoladas da pilha de produção.

## Browser

`browser/benchmark-browser-fast-path.mjs` mede `ação + estado atualizado` com 3 aquecimentos, 10 amostras e 10 fluxos completos por padrão. A qualificação local repete essa execução três vezes, sem descartar falhas ou outliers. O relatório compara chamadas individuais com `browser_sequence` e informa p50, p95, p99, tamanho das respostas e redução de tool calls.

```bash
npm run browser:performance:benchmark
```

As funções exportadas `evaluateBrowserPerformanceGates` e `summarizeOperationBenchmark` são usadas pelo release gate. A paridade com VS Code e a melhoria contra o engine anterior exigem referências capturadas na mesma máquina; o script não inventa baselines ausentes.

Para comparar os três motores no mesmo fixture local, preserve o engine anterior
em um clone limpo e já compilado. No VS Code, mantenha uma aba descartável do
navegador integrado visível e compartilhada com o agente e informe o `pageId`:

```powershell
npm run browser:performance:compare -- `
  --previous-root C:\tmp\mcp-browser-previous `
  --vscode-page-id <pageId>
```

O comparador executa 3 aquecimentos e 10 medições por padrão. Para qualificação local, execute três rodadas independentes sobre o mesmo código e configuração:

- VS Code: chamada MCP local que chega a `vscode.lm.invokeTool(click_element)`;
- engine anterior: `click` seguido de `snapshot`;
- candidate: `click` com estado incremental na mesma resposta.

O comparador navega temporariamente a aba descartável para o fixture e restaura
a URL original ao terminar. Preparação e restauração não entram nas amostras. A
aba visível é obrigatória porque uma página criada somente pela ponte local não
possui viewport acionável para o `locator.click()` nativo.

O JSON e o Markdown são salvos em `runtime/benchmarks/browser/<run-id>`. O
relatório registra máquina, versões, commits, hashes das fontes, limites de
medição, p50/p95/p99, bytes e tool calls. O comparador não inclui ngrok nem o
tempo de deliberação do modelo.

### Benchmarks de fluxo

`browser:performance:flows` executa fixtures legadas completas em candidate,
engine anterior e VS Code, mede também um gateway MCP loopback isolado e aplica
quadrado latino. O smoke usa uma preparação e três amostras:

```powershell
npm run browser:performance:flows -- `
  --previous-root C:\tmp\mcp-browser-previous `
  --suite local `
  --vscode-page-id <pageId> `
  --smoke
```

Sem `--smoke`, são cinco aquecimentos e 30 medições por fluxo/caminho. O modo
`--official` recusa árvore suja ou fonte sem commit imutável. A suíte
`--suite dev` exige `--dev-config` privado, perfis dedicados autenticados
manualmente e permanece somente leitura. Veja
`docs/operations/BROWSER_FLOW_BENCHMARKS.md`.

Nos fluxos com `frameset`, o caminho VS Code individual usa uma chamada
`run_playwright_code` por ação e o caminho batch uma chamada estática. O
adaptador aciona `HTMLElement.click()` pelo locator porque o clique coordenado
da versão 1.130.0 não alcança o documento filho nessa configuração; navegação e
pós-condições continuam obrigatoriamente validadas.

## MCP

`mcp/run.mjs` mede chamadas MCP completas e produz NDJSON, JSON, CSV e Markdown sem registrar argumentos, tokens ou conteúdo de arquivos.

```bash
npm run bench:mcp -- --config .runtime-private/benchmarks/mcp-config.json
```

Use `mcp/config.example.json` como base e mantenha tokens exclusivamente em variáveis de ambiente.
