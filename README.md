# MCP Access Stack

Pilha MCP privada para ChatGPT com acesso controlado a workspaces, Git, shell, validações e automação de navegador.

## Arquitetura ativa

```text
ChatGPT
  -> Cloudflare Worker / Durable Object
  <-> sessão WebSocket autenticada iniciada pelo Windows
  -> Edge Connector
       |- MCP Gateway embutido em loopback
       `- LocalAgent / workspace policy
            `-> Browser Worker em loopback
                 `-> Chromium com perfil MCP dedicado
```

Docker/V2, Compose, GHCR runtime, ngrok e o antigo proxy local foram aposentados.

A especificação arquitetural autoritativa está em `docs/architecture/EDGE_MCP_RUNTIME.md`.

## Desenvolvimento

Requisitos:

- Windows 10/11 x64;
- Node.js 26+;
- npm compatível com o lockfile;
- PowerShell 7;
- Git.

```powershell
git clone <REPOSITORY_URL>
Set-Location <REPOSITORY_ROOT>\mcp-access-stack
npm ci
npm run validation:tools:init
npm run check
```

## Runtime Windows

As tarefas persistentes canônicas são:

- `MCP Access Stack production edge-connector`;
- `MCP Access Stack production browser-worker`.

Instalação, staging, assinatura, atualização, persistência e rollback ficam em `deploy/windows/`. O Edge Connector abre somente conexões outbound; o Gateway embutido e o Browser Worker não expõem listeners públicos no Windows.

Segredos e estado privado ficam fora do Git em `.runtime-private/`, `.runtime-tools/`, `runtime/` e `releases/` conforme o contrato aplicável.

## Autorização

O Workspace Agent aplica allowlists, roots permitidos, paths bloqueados e classificação de risco. Foreground e background usam a mesma policy de confirmação. Autorizações são one-shot e vinculadas ao contexto/operação.

Package runners e deploy CLIs mutantes exigem confirmação. Push para `main` é confirmation-bound; formas ambíguas como `git push -C` e `git push --mirror` permanecem bloqueadas. Commit/merge local diretamente em `main` continuam protegidos.

### Aprovação local de diretórios para descoberta

Por padrão, `discover_local_repositories` pesquisa apenas na home do usuário do companion. Diretórios externos (incluindo worktrees no WSL) precisam ser aprovados **localmente**, não pela mensagem enviada ao ChatGPT.

No arquivo já existente `config.json` do companion (por padrão `%LOCALAPPDATA%\MCP V3\config.json` no Windows, ou o caminho definido por `MCP_V3_CONFIG_PATH`), acrescente a propriedade opcional `approvedDiscoveryRoots` com os caminhos exatos desejados. Exemplo de trecho JSON:

```json
"approvedDiscoveryRoots": [
  "\\\\wsl.localhost\\Ubuntu\\home\\USUARIO\\Projects\\jarvis",
  "\\\\wsl.localhost\\Ubuntu\\home\\USUARIO\\Projects\\jarvis-worktrees\\publish-stable-20261017"
]
```

Preserve `version`, `edgeBaseUrl` e as demais propriedades existentes. Substitua `USUARIO` pelo usuário Linux real. Cada raiz deve existir, ser absoluta, não ser a raiz de um volume e estar explicitamente listada. A autorização só vale para a descoberta iniciada **na raiz exata aprovada** (não para suas pastas irmãs); a varredura descendente segue os limites e a proteção contra links para fora. Se o WSL estiver indisponível, o companion continua inicializando e o caminho não é autorizado naquela tentativa.

A configuração é lida na inicialização do companion; não altere/reinicie o serviço em produção sem o gate operacional apropriado. Aprovar a descoberta **não registra** repositórios nem concede acesso Git automaticamente: a importação/binding e a política de workspace continuam separadas.

## Browser Worker

O Browser Worker usa Playwright direto em uma sessão Windows local e perfil Chromium dedicado ao MCP. Não reutiliza o perfil pessoal do usuário e não possui fallback Docker.

## Estrutura

```text
services/       Edge Gateway, MCP Gateway, Workspace Agent e Browser Worker
packages/       contratos, schemas, policies e protocolo compartilhado
operations/     ferramentas one-shot ainda ativas
deploy/windows/ distribuição e lifecycle Windows atual
tooling/        CI, benchmarks, qualificações e validações
docs/           arquitetura Edge vigente
config/         policies e exemplos sanitizados
```

## Gates principais

```powershell
npm run check
npm run test:typescript
npm run check:release-runtime
npm run check:persistence
npm run check:materialization
```

Testes `.mjs` usam `node:test`; serviços TypeScript usam Jest pelo runner comum em `tooling/testing/run-jest.mjs`.

## Regras

- não versionar estado privado, tokens ou perfis;
- não expor segredos em logs, argumentos ou manifests;
- não manipular abas pessoais do navegador;
- não encerrar processos apenas pelo nome;
- não fazer push, merge, promoção ou deploy fora dos gates de autorização aplicáveis.
