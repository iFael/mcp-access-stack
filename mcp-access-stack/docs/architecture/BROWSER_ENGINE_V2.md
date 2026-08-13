# Browser Engine v2

## Escopo

O Browser Engine v2 é o núcleo de automação distribuído na versão
`1.1.0-beta.1`. O objetivo é reduzir latência e quantidade de chamadas MCP sem
abrir mão do isolamento do perfil, das confirmações e da arquitetura híbrida:

```text
ChatGPT Desktop
  -> MCP Streamable HTTP
  -> ngrok + proxy + gateway no Docker
  -> HTTP loopback autenticado
  -> Browser Worker na sessão interativa do Windows
  -> Playwright direto
  -> Chromium gerenciado + perfil MCP persistente
```

Docker continua sendo o plano de controle público. O processo que possui
`BrowserContext`, `Page`, `Frame` e `Locator` permanece no Windows porque
Chromium headed, autenticação persistente, downloads, file chooser e sistemas
legados dependem da sessão gráfica do usuário.

## Corte arquitetural

O runtime final não contém:

- `@playwright/mcp`;
- `@playwright/cli`;
- conexão MCP interna;
- execução de comandos Playwright CLI;
- parser textual de respostas de outro motor;
- roteador MCP/CLI;
- reconciliação de aba por listagem no hot path.

`BrowserRuntime.create()` instancia `DirectPlaywrightDriver`. A única exceção é
a injeção explícita de um `BrowserDriverFactory` em testes e embeddings; não
existe fallback automático em produção.

## Kernel Playwright

`DirectPlaywrightDriver` abre um único `launchPersistentContext` e mantém:

- `WeakMap<Page, pageId>` para identidade por referência;
- `Map<pageId, Page>` para resolver `tabId` sem listar abas;
- página atual selecionada;
- tracker semântico e buffers de eventos por página;
- registro de console, rede, file chooser, downloads e crash;
- trace e screencast ativos;
- armazenamento privado de artefatos.

O `remoteTabId` persistido inclui o `pageId`. Seleções normais usam
`selectTabByRemoteId()` em O(1). Título, URL e índice são metadados de
diagnóstico e recuperação. Após restart, o serviço de persistência tenta
restaurar URLs e bindings. Se não houver correspondência inequívoca, o motor
retorna `STALE_TAB_ID`; não executa uma ação em uma página aproximada.

Eventos `page`, `popup`, `close`, `crash`, `frameattached`, `framedetached` e
`framenavigated` atualizam ou invalidam o estado imediatamente.

## Concorrência

`BrowserOperationQueue` mantém uma cauda por chave:

- `tab:<tabId>` serializa operações da mesma aba;
- chaves diferentes progridem em paralelo;
- o limite padrão é quatro operações de abas distintas;
- operações de contexto usam a chave global `context`.

Timeout HTTP não libera antecipadamente a cauda da aba. A resposta pode
encerrar, mas a ação subjacente termina antes da próxima ação daquela aba. Isso
elimina sobreposição acidental sem reintroduzir o bloqueio global.

## Snapshot semântico

Cada `Page` possui:

- `documentId`;
- revisão monotônica;
- as últimas 32 revisões;
- sequência de eventos limitada a 500 entradas.

Na conexão, o engine executa um probe de
`ariaSnapshot({ mode: "ai", _track: "response" })`. A opção privada é usada
somente com a versão Playwright fixada. Falha no probe ou em uma captura
desativa `_track` e usa `ariaSnapshot({ mode: "ai" })`; o engine continua
disponível.

O retorno público pode ser:

- `full`: documento novo, revisão desconhecida, histórico expirado ou
  `forceFull`;
- `delta`: conteúdo ou eventos posteriores à revisão conhecida;
- `unchanged`: conteúdo e eventos já conhecidos;
- `unavailable`: reservado para degradação estruturada.

Refs são resolvidas diretamente por `page.locator("aria-ref=" + ref)`. Uma
navegação de documento ou mudança estrutural de frame invalida o tracker, gera
novo `documentId` e impede que refs antigas sejam usadas no documento novo.

Clique, preenchimento, tecla, espera, abertura, navegação e ações mutáveis em
frame capturam o novo estado antes de devolver a própria resposta. O
controlador acrescenta `queueMs`; o runtime informa `actionMs`, `snapshotMs` e
`totalMs`.

## Sistemas legados

Frames não são acessados por `contentDocument` no caminho direto.
`resolveFramePath()` percorre `Frame.childFrames()` e reconhece, em ordem:

1. índice numérico;
2. `Frame.name()`;
3. atributo `name` do elemento;
4. atributo `id` do elemento.

Como a avaliação é feita pelo próprio objeto `Frame`, frames cross-origin são
tratados sem violar a política de mesma origem do JavaScript da página.

Quando a árvore ARIA é esparsa, o snapshot acrescenta um resumo limitado por
frame com texto visível, campos, valores não sensíveis, botões, links e
tabelas. Senhas são substituídas por `[redacted]`. A varredura complementar só
ocorre quando o snapshot é pequeno ou contém menos de três refs.

`BrowserLegacyAutomationService` mantém os contratos de profile, índice,
sequência e navegação LegacySite. No engine direto:

- o grafo e os sinais são coletados por objetos `Frame`;
- `domIndex` executa dentro do frame resolvido;
- uma sequência preflighta todos os alvos perigosos antes da primeira mutação;
- cada etapa re-resolve o frame, tolerando postbacks e substituição de DOM;
- navegação pode aguardar mudança de assinatura em outro frame;
- confirmações de submit e ação destrutiva permanecem obrigatórias.

## Eventos e diagnóstico

O tracker registra eventos sanitizados de:

- console e `pageerror`;
- request, response e falha de request;
- diálogo;
- download;
- file chooser.

Somente eventos posteriores à revisão conhecida são anexados ao delta.
Cabeçalhos de autorização, cookies, tokens, chaves e parâmetros sensíveis são
redigidos nos diagnósticos.

Screenshot, PDF, trace, upload e download usam APIs Playwright diretas. Vídeo
dinâmico usa `Page.startScreencast` por CDP, grava JPEGs em diretório privado e
os envia por `image2pipe` ao ffmpeg empacotado pelo Playwright. O diretório de
frames é removido após finalizar ou falhar.

## Idempotência e retries

Correlação e idempotência são identidades distintas:

- `correlationId` identifica a solicitação MCP para tracing, cancelamento e logs;
- `invocationId` identifica uma execução lógica individual de uma tool;
- `x-mcp-call-id` é derivado de `invocationId` e do fingerprint canônico da
  operação com seu input.

O fingerprint usa JSON canônico com chaves de objetos ordenadas e SHA-256. Com
isso, duas operações diferentes sob o mesmo `correlationId` recebem chaves
diferentes, enquanto um retry da mesma invocação, operação e input preserva a
mesma chave.

Operações mutáveis são registradas pelo Browser Worker com TTL padrão de cinco
minutos e limite padrão de 4.096 entradas:

- retry com a mesma chave e fingerprint recebe a mesma `Promise`/resposta;
- a ação não é executada novamente;
- reutilizar a chave com outro fingerprint retorna
  `IDEMPOTENCY_KEY_CONFLICT` antes de executar a nova ação;
- falhas removem a entrada para permitir recuperação explícita;
- entradas em execução não expiram e não são expulsas;
- quando o limite é atingido, somente entradas concluídas podem ser expulsas;
- se todas as entradas estiverem ativas, a nova operação falha com
  `LIMIT_EXCEEDED` sem ser executada.

Ao receber `IDEMPOTENCY_KEY_CONFLICT`, o Gateway registra um alerta sanitizado e
repete uma única vez com uma chave de recuperação determinística. A chave de
recuperação permanece estável para retries posteriores da mesma invocação. Um
segundo conflito é devolvido ao cliente, sem novas tentativas.

As configurações são:

- `BROWSER_WORKER_IDEMPOTENCY_TTL_MS`;
- `BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES`.

Os resultados de `status` e `connect` expõem métricas sanitizadas do registro:
`entries`, `hits`, `misses`, `conflicts`, `evictions` e `expirations`. Chaves e
inputs nunca são expostos; logs de conflito registram somente o prefixo do hash.

Operações de leitura não entram no cache.

## Segurança

- o worker escuta apenas em `127.0.0.1`;
- o gateway usa bearer token individual no loopback;
- políticas de URL e SSRF continuam antes de navegação;
- upload/download permanecem dentro da área privada;
- o perfil certificado fica dentro de `browser.privateDirectory`;
- o perfil pessoal do Chrome nunca é aceito;
- conteúdo de página e snapshot é entrada não confiável, não instrução;
- JavaScript arbitrário não é ferramenta MCP pública;
- ações sensíveis preservam confirmação e binding de alvo.

## Configuração e versão

O formato host do navegador é versão 2:

```json
{
  "version": 2,
  "engine": "playwright-direct",
  "profileMode": "persistent",
  "browserChannel": "chromium",
  "maxConcurrentTabs": 4
}
```

Campos `extensionTokenFile` e `cliSessionName` são removidos pela migração. O
status publica `engineVersion`, protocolo, Playwright, canal, revisão Chromium
e capacidades incrementais. O manifesto imutável registra também a versão 4
do estado persistido e os IDs SHA-256 das imagens Docker.

## Validação e release gate

A qualificação local pré-versionamento executa três rodadas independentes. Cada rodada usa:

- 3 aquecimentos;
- 10 medições de `ação + estado`;
- 10 repetições dos fluxos completos;
- p50, p95 e p99;
- bytes de resposta e tool calls.

O benchmark oficial permanece separado: exige candidate e baseline imutáveis, 5 aquecimentos e 30 medições.

As referências do engine anterior e do VS Code precisam ser capturadas na
mesma máquina. O gate obrigatório exige:

- p95 não pior que o VS Code de referência;
- pelo menos 35% de melhoria contra o engine anterior;
- pelo menos 50% de redução de tool calls;
- overhead gateway-engine de no máximo 5%;
- sucesso por ação de 100% nos gates de estabilidade;
- zero mutação duplicada;
- zero bloqueio cruzado entre abas.

O alvo de 20% sobre o VS Code é informado separadamente e não é declarado sem
evidência.

Os gates do ambiente de desenvolvimento são curtos, estritos e repetidos:

- `quick`: 30 ações reais, sem injeção de falha, para regressão de mudança;
- `candidate`: 20 minutos e 150 ações por execução, com recuperação controlada,
  repetido duas vezes de forma independente;
- `stability`: 30 minutos e 300 ações por execução, com recuperação controlada,
  repetido três vezes de forma independente.

Tempo e volume são requisitos simultâneos em cada execução; o timeout apenas
limita uma execução travada. Não existe gate de oito horas nem requisito de
1.000 ações. Cada chamada MCP gera evidência própria com nome, resultado e
latência. Os relatórios registram commit, estado limpo da árvore, p50/p95/p99,
reinícios e falhas de recuperação. `candidate` e `stability` recusam árvores
sujas, exigem 100% das ações aprovadas e produzem um relatório independente por
repetição.

O rollout ocorre no ambiente de desenvolvimento. A promoção continua explícita e atômica. A
release estável contém apenas o engine direto; rollback reativa a release
imutável anterior.

## Distribuição pública

O workflow de tag publica duas imagens GHCR por digest, com SBOM e provenance,
e um pacote Windows x64. A publicação falha sem certificado Authenticode. O
pacote contém:

- release host imutável e manifesto SHA-256 assinado;
- instalador e atualizador assinados;
- commit, protocolo, Playwright e revisão Chromium;
- referências imutáveis das imagens Gateway e Proxy.

O instalador usa OAuth owner gerado por instalação e ngrok no Docker; tokens
não são escritos em linha de comando de processo filho. O atualizador é
candidate-first: baixar e validar não altera `active.json`; `-Promote` é
explícito e aciona o fluxo existente de health check e rollback.
