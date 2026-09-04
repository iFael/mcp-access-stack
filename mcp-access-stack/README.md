# MCP Access Stack — GPT-only

Pilha MCP dedicada ao ChatGPT, com acesso controlado a workspaces, Git, shell, validações e automação de navegador.

## Arquitetura

```text
ChatGPT
  -> túnel HTTPS (Docker)
  -> proxy MCP :3300 (Docker)
  -> gateway :3310 (Docker)
     |-> Workspace Agent (Windows)
     `-> Browser Worker :3350 (Windows)
```

Os hosts Windows executam por tarefas agendadas:

```text
McpNodeHostLauncher.exe
  -> node.exe
    -> Run-DockerHostComponent.mjs --task-owned true
      -> componente
```

Não há Cursor, Codex, colaboração ou supervisor local na arquitetura ativa.

## Pré-requisitos

- Windows 10 ou 11 x64;
- Node.js 26 ou superior;
- npm compatível com o lockfile;
- PowerShell 7;
- Git;
- Chromium gerenciado pelo Playwright;
- Docker Desktop para a produção híbrida;
- domínio e token ngrok para o túnel em Docker.

## Instalação de desenvolvimento

```powershell
git clone <REPOSITORY_URL>
Set-Location <REPOSITORY_ROOT>\mcp-access-stack
npm ci
npm run validation:tools:init
npm run check
```

`npm run check` executa validação estrutural, sintaxe, testes, typecheck e build.

## Configuração privada

```powershell
Copy-Item config\workspace-policy.example.json config\workspace-policy.local.json

npm run production:init -- `
  -PublicBaseUrl https://SEU_SUBDOMINIO.example `
  -TunnelExecutable C:\caminho\para\ngrok.exe
```

O inicializador gera tokens e configuração privada, mas não inicia processos. Segredos permanecem em `.runtime-private/`.
### Confirmação de comandos por workspace

Cada workspace pode definir `confirmationMode`:

- `standard` é o default e preserva integralmente o comportamento de confirmação existente;
- `trusted-workspace` só é válido com `permissionProfile: "full-repo-write"` e pode dispensar confirmação para mutações locais deterministicamente analisadas cujos alvos sejam comprovadamente contidos em `allowedRoots` e `allowWrites`.

`trusted-workspace` não desabilita o classificador de risco. Comandos ambíguos continuam exigindo confirmação, e `blockedGlobs`/`mandatoryBlockedGlobs`, proteção de Git remoto, caminhos externos, Docker destrutivo, Registry, serviços, Scheduled Tasks, UAC, discos, credenciais e demais operações de sistema continuam protegidos independentemente do modo. Background tasks destrutivas permanecem bloqueadas.

## Isolamento do navegador

O Browser Worker v1.1 usa somente o engine Playwright direto. Um Chromium gerenciado é iniciado na sessão gráfica do Windows com diretório dedicado dentro de `browser.privateDirectory`, sem reutilizar cookies, contas, histórico ou abas do perfil pessoal.

Para restaurar explicitamente esse modo na configuração privada:

```powershell
npm run browser:profile:persistent
```

O modo de extensão e os drivers MCP/CLI foram removidos. Quando a configuração Docker de produção existe, `browser:profile:persistent` também migra `docker/production/browser.json` para o formato v2 e remove campos antigos de extensão/CLI. O Browser Worker precisa ser reiniciado separadamente em uma janela operacional autorizada.

## Produção Docker

```powershell
npm run docker:production:init
npm run docker:release:state:init -- -Execute
npm run docker:production:status
```

A implantação e o lifecycle dos hosts estão documentados em:

- `deploy/docker/README.md`;
- `docs/operations/HOST_RELEASE_LIFECYCLE.md`;
- `docs/operations/RUNBOOK.md`.

Tags SemVer publicam imagens GHCR por digest e um pacote Windows x64 assinado.
O instalador e o atualizador candidate-first estão em `deploy/windows/`; o
contrato completo está em `docs/operations/HOST_RELEASE_LIFECYCLE.md`.

As releases Windows usam um certificado Authenticode self-signed exclusivo do
projeto. A chave privada não é versionada. O certificado público fica em
`deploy/windows/mcp-access-stack-code-signing.cer` e o verificador exige o
thumbprint canônico `EC1DACA3C03E386BAB8E95B6E7929A4CA8342672`. Em um Windows
que ainda não confia nesse certificado, a confiança é uma decisão local do
usuário; o projeto não depende de uma CA comercial.

Os testes de resistência do ambiente de desenvolvimento são separados em
`docker:development:gate:quick`, `docker:development:gate:candidate` e
`docker:development:gate:stability`. A política é adaptativa: `quick` cobre
mudanças localizadas, `candidate` usa uma execução curta com reinícios
controlados e `stability` mantém duas execuções mais longas para alterações de
alto risco. Não existe soak prolongado de oito horas.

## Estrutura

```text
services/       Gateway, Workspace Agent e Browser Worker
packages/       contratos, schemas e políticas compartilhadas
operations/     configuração, proxy e ferramentas operacionais
deploy/         Docker, releases e tarefas Windows
tooling/        benchmarks, smoke tests e validação estrutural
docs/           arquitetura, integração, operação e segurança
config/         políticas e exemplos sanitizados
```

## Testes

```powershell
npm run test:typescript
npm run test:mcp-core
npm run test:browser-worker
npm run test:workspace-agent
npm run test:mcp-gateway
```

Testes `.mjs` usam `node:test`; serviços TypeScript usam Jest.

## Regras de segurança

- não versionar `.runtime-private/`, `.runtime-tools/`, `runtime/` ou `releases/`;
- não expor tokens, URLs privadas, perfis ou caminhos pessoais;
- não executar comandos destrutivos sem confirmação;
- não manipular abas pessoais do Chrome;
- não encerrar processos apenas pelo nome;
- não fazer push, merge, rebase ou promoção de release sem autorização.
