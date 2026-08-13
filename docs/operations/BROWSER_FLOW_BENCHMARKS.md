# Benchmarks de fluxo do Browser Engine

## Objetivo

A suíte `browser:performance:flows` mede fluxos completos sem incluir a
deliberação do modelo. Ela preserva duas camadas:

- `local`: gate oficial reproduzível na mesma máquina;
- `dev`: observação somente leitura do LegacySite Dev.

O harness nunca reutiliza o Browser Worker, gateway, containers, perfis ou abas
protegidas da produção. Candidate e baseline anterior são iniciados em portas e
perfis próprios. Por padrão, o gateway medido é construído a partir da árvore
candidate e iniciado em um container Docker temporário, com nome, porta e rede
isolados. Ele alcança somente o worker candidate por um relay TCP temporário,
autenticado pelo token aleatório da rodada.

Nenhum schema MCP público é alterado.

## Fluxos locais

| ID | Pós-condição exata |
|---|---|
| `legacy-menu-cold` | Financeiro → CPX-Finance → Histórico, frame de destino pronto e cache frio |
| `legacy-menu-warm` | Mesmo caminho após reload, cache encontrado e revalidado |
| `large-menu` | Mais de 2.500 itens indexados e navegação segmentada entre frames |
| `multi-frame-form` | fill, select, press, extract e assert concluídos |
| `controlled-postback` | confirmação emitida, documento substituído e exatamente um POST |

As fixtures são servidas em loopback pelo próprio processo. Cada amostra recebe
um nonce. O servidor conta POSTs por nonce, tornando duplicação mutável um erro
mensurável.

## Execução rápida

Compile candidate e baseline antes da medição. Mantenha uma aba descartável,
visível e compartilhada no navegador integrado do VS Code:

```powershell
npm run browser:performance:flows -- `
  --previous-root C:\tmp\mcp-browser-previous `
  --suite local `
  --vscode-page-id <pageId> `
  --smoke
```

`--smoke` executa um aquecimento e três amostras por caminho. Sem esse
argumento, são cinco aquecimentos e 30 medições.

Para depuração rápida do harness, `--gateway-mode process` evita o build do
container. Esse resultado fica marcado como host-process e não é aceito com
`--official`; o gate oficial sempre exige `--gateway-mode docker`, que também é
o padrão.

A fronteira comparável de cada fluxo começa na primeira ação necessária e termina somente após a pós-condição exata. No candidate, `browser_navigate_path` aceita um `checkpoint` final estritamente não mutável (`waitFor`, `extract` ou `assert`), mantendo navegação e evidência na mesma chamada. Baselines antigos usam um fallback adicional no adaptador, dentro da mesma janela medida.

Em cada amostra a ordem gira em quadrado latino:

1. anterior → candidate → VS Code;
2. candidate → VS Code → anterior;
3. VS Code → anterior → candidate.

Dentro do candidate, a ordem direto/gateway também alterna. No VS Code, a
ordem individual/lote alterna.

Candidate, baseline e VS Code são comparados também por índice de amostra. O relatório publica cobertura pareada, deltas pareados, taxa de sucesso, desvio-padrão e coeficiente de variação. Uma amostra que falha permanece no relatório e deixa de participar do par; o gate exige cobertura completa.

O VS Code não declara cache estrutural equivalente ao engine. Nos fluxos cold/warm ele publica apenas primeira execução e repetição. No postback controlado, candidate e baseline publicam a latência total do protocolo de confirmação e a latência de execução autorizada; a comparação entre engines usa a execução autorizada porque a bridge do VS Code não possui challenge equivalente.

O caminho VS Code individual mantém uma chamada da ferramenta nativa
`run_playwright_code` por ação; o lote usa uma única chamada estática. Em
`frameset`, a versão 1.130.0 observada não entrega o clique coordenado ao
documento filho, mesmo com a aba ativa e visível. Por isso, somente no adaptador
VS Code, o locator aciona `HTMLElement.click()` no frame. O evento, a ação
padrão, a navegação e a pós-condição continuam sendo executados e validados pelo
navegador; o relatório identifica os caminhos individual e lote separadamente.

## Relatório oficial

Uma execução exploratória aceita árvore suja e grava `official: false`. Para o
gate de release:

```powershell
npm run browser:performance:flows -- `
  --previous-root C:\tmp\mcp-browser-previous `
  --suite local `
  --vscode-page-id <pageId> `
  --official
```

`--official` recusa candidate ou baseline sem commit Git imutável e árvore
limpa. Antes de iniciar qualquer medição, o harness executa `npm run build` nas
duas raízes, verifica novamente que commit e `sourceTreeSha256` não mudaram e
calcula um SHA-256 conjunto dos artefatos em `packages/mcp-core/dist`,
`services/browser-worker/dist` e `services/mcp-gateway/dist`. Um `dist`
preexistente nunca é aceito como evidência suficiente: falha de build, árvore
alterada ou artefato ausente interrompe a rodada oficial. A proveniência
`rebuilt-from-clean-source`, o comando, o horário e o hash do build ficam no
JSON. JSON e Markdown são gravados em
`runtime/benchmarks/browser/flows/<run-id>/`.

O gate local exige:

- zero pós-condição incorreta;
- zero POST duplicado;
- taxa de sucesso candidate e Gateway de pelo menos 99,5%;
- challenge de confirmação observado em 100% dos postbacks candidate medidos;
- cobertura pareada completa em todas as medições;
- p95 agregado candidate não pior que o melhor caminho VS Code equivalente;
- pelo menos 35% de melhoria contra o engine anterior;
- pelo menos 50% de redução de tool calls contra o caminho individual;
- overhead do gateway isolado de no máximo 5%.

A meta de 20% sobre o VS Code é publicada separadamente e não é misturada ao
gate obrigatório.

O relatório publica duas medidas de overhead. A medida pareada subtrai a fronteira HTTP direta do Worker da fronteira total MCP/Gateway e permanece como diagnóstico de variação entre execuções. Quando 100% das chamadas possuem telemetria opt-in, o gate usa o overhead diretamente atribuível ao Gateway: tempo fora do BrowserWorkerClient antes da escrita da resposta mais o residual cliente/HTTP após essa escrita, dividido pela duração direta pareada. Essa medida elimina a variação do engine sem ocultar custos do Gateway. Se a cobertura de telemetria não for integral, o gate retorna automaticamente ao percentual incremental pareado. O limite permanece p95 <= 5%.

A imagem Docker temporária recebe uma label com o SHA-256 exato da árvore source. Ela só é reutilizada quando tag e label correspondem; imagens sem provenance ou com hash diferente são reconstruídas. Containers e redes continuam exclusivos do namespace `mcp-browser-flow-*`.

## LegacySite Dev

Copie `tooling/benchmarks/browser/dev-config.example.json` para um caminho
privado fora do Git. O arquivo aceita somente:

- URL HTTPS exata de `dev-private.example.test`;
- três diretórios de perfil distintos;
- janela fixa de sete dias;
- limite fixo de 20 linhas.

Chaves ou valores semelhantes a token, cookie, credencial, senha ou segredo são
rejeitados. Perfis pessoais de Chrome e Edge também são rejeitados.

Prepare os perfis candidate e anterior manualmente:

```powershell
npm run browser:performance:prepare-profile -- `
  --root <raiz-do-engine> `
  --profile C:\McpBrowserBenchmark\profiles\candidate `
  --url https://dev-private.example.test/app `
  --channel chromium
```

Repita para o baseline anterior usando sua raiz e perfil. Para o VS Code,
inicie uma instância dedicada com
`code --user-data-dir C:\McpBrowserBenchmark\profiles\vscode`, instale/ative a
bridge local nessa instância, autentique manualmente e use somente uma aba
descartável compartilhada.

Execute:

```powershell
npm run browser:performance:flows -- `
  --previous-root C:\tmp\mcp-browser-previous `
  --suite dev `
  --vscode-page-id <pageId-da-instancia-dedicada> `
  --dev-config C:\McpBrowserBenchmark\dev-config.json
```

O preflight valida domínio, ambiente Dev, frames `Menu` e `MenuContent`, acesso
ao item CPX-Finance, cabeçalho, filtros e área de resultados. Conseguir resolver
o item restrito e abrir a tela é a evidência operacional do grupo autorizado.

O catálogo executável permite somente:

- abrir a fila;
- preencher data inicial/final e limite;
- preservar a conta selecionada;
- pressionar `Atualizar`;
- navegar por Conferências, Pendências e Histórico;
- ler no máximo 20 linhas.

`Analisar selecionados`, registro de decisões, exportação, download,
configurações, laboratórios e Produção são bloqueados antes da execução. POSTs
somente leitura ainda passam pelo protocolo de confirmação do engine.

Conteúdo de linhas financeiras nunca entra no relatório. Candidate, baseline e VS Code aplicam a mesma canonicalização de whitespace e acentos e o mesmo SHA-256 sobre `rowCount + texto sanitizado da grade`. O texto bruto permanece apenas em memória até a assinatura ser calculada.

Dev começa em modo `observational`. Ele só muda para `gate` após três relatórios
da mesma versão/árvore, em momentos diferentes, com coeficiente de variação de
até 15% no p95 de cada fluxo. Erro funcional, tentativa de escrita ou quebra de
autenticação interrompe a rodada imediatamente.

## Transporte público

O endpoint público/ngrok não pertence ao gate local e não é chamado
automaticamente. O relatório registra `not-measured` até existir uma execução
implantada explicitamente autorizada. Isso impede que um benchmark local
modifique containers ou abas protegidas da produção.
