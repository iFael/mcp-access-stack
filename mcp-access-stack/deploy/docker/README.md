# Implantação Docker híbrida

```text
ChatGPT -> Tunnel -> Proxy -> Gateway
                           |-> Workspace Agent no Windows
                           `-> Browser Worker no Windows
```

Gateway, Proxy e Tunnel executam em containers. Agent e Browser Worker permanecem no Windows por dependerem de workspaces locais, Git, shells autorizados e sessão interativa do Chrome.

## Portas

Produção:

- Proxy: `3300`;
- Gateway: `3310`;
- Browser Worker: `3350`.

Ambiente de Desenvolvimento:

- Proxy: `4300`;
- Gateway: `4310`;
- bridge opcional do Browser Worker: `4350`.

Configurações privadas ficam em `.runtime-private/docker/` e não entram no Git.

> O identificador técnico e operacional canônico deste ambiente é `development`. Novos scripts, comandos, arquivos e configurações não devem usar a nomenclatura histórica removida nesta migração.

## Ambiente de Desenvolvimento

```powershell
npm run docker:development:init
npm run docker:development:up
npm run docker:development:test
npm run docker:development:test:resilience
npm run docker:development:down
```

O ambiente de desenvolvimento deve ser encerrado após a homologação quando não for necessário. Não mantenha containers ou processos desse ambiente ativos sem necessidade.

### Ownership da policy

Produção e Ambiente de Desenvolvimento usam snapshots físicos independentes da workspace policy:

```text
%LOCALAPPDATA%\McpAccessStack\environments\production\workspace-agent\policy.json
%LOCALAPPDATA%\McpAccessStack\environments\development\workspace-agent\policy.json
```

Cada snapshot possui `policy.manifest.json`, SHA-256 e contagem de workspaces. O identificador de ambiente é usado diretamente para selecionar o diretório canônico correspondente.

Para inspecionar uma instalação antiga sem alterar arquivos:

```powershell
npm run docker:environment-policy:migrate
```

A migração real exige `-Execute`, cria backup da configuração e **não reinicia** Agent ou Browser Worker. A ativação da nova policy ocorre somente em restart/release explicitamente autorizado.

## Produção

```powershell
npm run validation:tools:init
npm run docker:production:init
npm run docker:release:state:init -- -Execute
npm run docker:production:status
```

## Release imutavel - fluxo canonico

O PC produtivo nao compila nem transporta imagens Docker em TAR. O caminho canonico e a distribuicao publica assinada produzida por `.github/workflows/release.yml`:

```text
GitHub Actions
  -> valida o commit/tag com CI completo
  -> build e push Gateway/Proxy no GHCR
  -> captura digests sha256 imutaveis
  -> build do runtime Windows sem imagens Docker
  -> assina scripts + attestation + distribution manifest
  -> publica ZIP Windows x64 + SHA-256 no GitHub Release
```

O MCP Node executa somente:

```text
GitHub Release publico
  -> baixa ZIP Windows
  -> valida SHA-256 + Authenticode
  -> valida release-attestation.ps1
  -> docker pull gateway@sha256:<digest>
  -> docker pull proxy@sha256:<digest>
  -> valida RepoDigest + linux/amd64
  -> instala release imutavel
  -> atualiza candidate.json
  -> opcionalmente solicita promocao a Scheduled Task privilegiada
```

Para atualizar um Node ja instalado:

```powershell
npm run docker:production:update -- `
  -Execute `
  -Repository <owner>/mcp-access-stack
```

Sem `-Promote`, somente `candidate.json` e preparado. Com `-Promote`, o updater nao executa o cutover diretamente: ele chama `Request-McpProductionPromotion.ps1`, que valida a attestation assinada e grava um pedido para a tarefa `McpAccessStack-Production-Promotion`.

A tarefa privilegiada executa PowerShell com `ExecutionPolicy=AllSigned`, revalida a release assinada e entao reutiliza o lifecycle existente de promocao/rollback. O checkout Git nao participa do gate de producao.

O runtime publico nao inclui source TypeScript, testes, documentacao, toolchain de build, Docker TARs nem estado privado. `New-McpRelease.ps1` continua sendo usado pelo runner de release para montar os `dist` e dependencias de producao; `New-McpPublicDistribution.ps1` reduz e assina o payload distribuido ao Node.

## Hosts Windows
```text
Task Scheduler
  -> McpNodeHostLauncher.exe
    -> node.exe
      -> Run-DockerHostComponent.mjs --task-owned true
        -> componente
```

O launcher nativo não abre console. O runner mantém `runner-lease.json`, reinicia o componente até o limite configurado e encerra o filho quando a tarefa é parada.

Instalação desativada por padrão:

```powershell
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Install-McpHostTasks.ps1 `
  -Environment production `
  -ReleaseRoot <candidate-release-root>
```

Ative as tarefas somente depois de validar a release e possuir backup das definições atuais.

## Promoção do candidato

A promoção continua usando o lifecycle versionado existente: backup dos ponteiros, `compose.env` e XMLs das tarefas; `docker compose --no-build`; troca controlada de Agent e Browser Worker; health checks; ativação do ponteiro somente no final; rollback automático em falha.

A diferença é a elevação. Instale **uma única vez**, em PowerShell Administrador, a Scheduled Task manual-only dedicada:

```powershell
npm run docker:production:promoter:install -- -Execute
```

Essa task usa `RunLevel Highest`, não possui trigger automático e não aceita comando arbitrário. O único request operacional contém `releaseId`, timeout limitado e um request ID. Antes de executar, tanto o caller quanto o broker elevado revalidam `candidate`, Git clean e igualdade exata entre `main`, `origin/main` e o commit do candidato.

Depois da instalação inicial, a promoção normal é solicitada por uma sessão **não elevada**, sem UAC por release:

```powershell
npm run docker:production:promote:request -- `
  -Execute `
  -ExpectedReleaseId <release-id>
```

O comando retorna `requestId` e `resultPath`. A execução continua em Task Scheduler mesmo enquanto o Agent é reiniciado. O resultado terminal fica em `runtime/production-promotion/requests/<request-id>/result.json`.

Os entrypoints `docker:production:promote` e `docker:production:promote:detached` permanecem como fallback operacional deliberado, mas não são mais o caminho canônico quando a task dedicada está instalada.

Por padrão, o Browser Worker precisa responder em `/health/live`. `-RequireBrowserReady` pode ser solicitado no broker quando a prontidão `200` do Chromium gerenciado for requisito obrigatório da janela.

`Activate-McpCandidateRelease.ps1` permanece como operação de baixo nível. Não o execute isoladamente para uma promoção normal, pois ele altera apenas o ponteiro ativo e não realiza cutover ou rollback.

## Validação

```powershell
npm run check
npm run docker:production:status
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Test-NativeHostLauncher.ps1
```

Para mudanças Docker, execute o ambiente de desenvolvimento e selecione o gate proporcional:

```powershell
# Mudança localizada: 2 minutos + 35 ações, sem reinício.
npm run docker:development:gate:quick

# Beta candidate: 5 minutos + 100 ações, uma execução e dois reinícios controlados.
npm run docker:development:gate:candidate

# Estabilidade final: 20 minutos + 250 ações, duas execuções e quatro reinícios por execução.
npm run docker:development:gate:stability
```

Cada execução de `candidate` e `stability` precisa atingir tempo, volume e o
número planejado de reinícios na mesma execução; o timeout apenas limita uma
execução travada. Não existe soak
de oito horas nem requisito de 1.000 ações. Os relatórios NDJSON ficam em
`runtime/docker-development`, registram cada chamada MCP e exigem 100% das ações
aprovadas. Os dois gates de release recusam uma árvore Git suja e geram um
relatório independente por repetição, vinculando a evidência a um commit
imutável.

## Docker Desktop

Falhas com o pipe `dockerDesktopLinuxEngine` indicam indisponibilidade do Docker Desktop, não falha do protocolo MCP. Aguarde `docker version` apresentar o servidor antes de repetir os testes.
