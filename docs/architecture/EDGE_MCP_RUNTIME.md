# Edge MCP Runtime

## Status

Esta é a arquitetura de produção vigente do MCP Access Stack.

```text
ChatGPT
  -> Cloudflare Worker
  -> Durable Object session
  <-> WebSocket autenticado iniciado pelo Windows
  -> Edge Connector
       |- MCP Gateway embutido em loopback
       `- LocalAgent / InProcessWorkspaceExecutor
            |- filesystem, Git, shell, validações e background tasks
            `-> Browser Worker em loopback
                 `-> Chromium com perfil MCP dedicado
```

GitHub é autoritativo para source, CI, build e publicação de artefatos Windows. Cloudflare fornece a borda pública e coordena a sessão. O Windows mantém somente capacidades que exigem presença local.

Docker/V2, Compose, runtime GHCR, ngrok, proxy container, remote-compose e o antigo proxy local foram aposentados.

## Edge

`services/mcp-edge-gateway` fornece a borda Cloudflare:

- health/readiness;
- sessão Durable Object;
- autenticação do conector;
- relay das rotas MCP e Owner OAuth explicitamente permitidas;
- cancelamento, limites de payload, concorrência e deadline;
- telemetria do conector.

O protocolo Edge↔Connector fica em `packages/edge-protocol` e é versionado. Incompatibilidade falha fechada.

## Edge Connector

O entrypoint Windows fica em `services/mcp-gateway/src/edge-connector-cli.ts`. Ele inicia a sessão outbound para o Worker e reutiliza o MCP Gateway e o `LocalAgent` existentes. Não existe um segundo engine de autorização ou execução.

A tarefa persistente canônica é `MCP Access Stack production edge-connector`, instalada por `deploy/windows/Install-McpEdgeConnectorTask.ps1`.

O conector não abre listener público. O Gateway embutido é somente loopback.

## Browser Worker

O Browser Worker permanece como processo Windows separado porque controla Chromium em sessão gráfica local. A tarefa canônica é `MCP Access Stack production browser-worker`, instalada por `deploy/windows/Install-McpBrowserWorkerTask.ps1`.

O Worker usa perfil Chromium dedicado ao MCP, listener loopback e token privado. Não reutiliza perfil pessoal e não possui fallback Docker.

## Autenticação e segredos

Owner OAuth continua sendo implementado pelo MCP Gateway. O Edge apenas relaya as rotas necessárias; não cria uma autenticação paralela.

Segredos não entram no Git, em argumentos de Scheduled Task ou em logs. O conector usa arquivo apontado por `MCP_CONNECTOR_TOKEN_FILE`; Owner e Browser Worker usam arquivos privados delimitados pelos scripts Windows.

## Workspace execution

`LocalAgent` e `InProcessWorkspaceExecutor` permanecem autoritativos para filesystem, Git, shell, validações e background tasks.

O fluxo de autorização é único:

```text
command -> classification -> authorization -> confirmation -> execution
```

Foreground e background usam a mesma policy. Confirmações são one-shot e vinculadas a workspace, shell, cwd, comando, contexto e operação.

Package runners e deploy CLIs mutantes exigem confirmação. Push para `main` é confirmation-bound. `git push -C` e `git push --mirror` permanecem hard-blocked; commit/merge local em `main` continuam protegidos.

## Release e distribuição

O fluxo público vigente está em `.github/workflows/release.yml` e `deploy/windows/`.

O pipeline valida o commit exato, constrói os artefatos Windows, assina a distribuição, executa os gates aplicáveis e publica assets imutáveis no GitHub Release. O PC de produção não compila source nem executa Docker build durante atualização/promoção.

O contrato v2 não contém `dockerImages`. Leitura de `dockerImages` v1 permanece somente onde necessária para compatibilidade histórica de releases antigas; isso não reintroduz Docker no runtime atual.

## Gates

Os gates executáveis são a fonte operacional de verdade:

- `npm run check`;
- `npm run check:release-runtime`;
- `npm run check:persistence`;
- `npm run check:materialization`;
- testes específicos de Edge/Windows afetados pela alteração;
- diff-check e secret scan antes de integrar uma mudança ampla.

Não existem runbooks operacionais paralelos; comandos e invariantes vivem nos scripts, manifests, package scripts e testes do próprio repositório.
