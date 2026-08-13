# Componentes

## Núcleo

### `services/mcp-gateway`

Gateway MCP remoto. Publica ferramentas de workspace e navegador, valida autenticação e encaminha operações ao Workspace Agent e ao Browser Worker.

### `services/workspace-agent`

Agente Windows responsável por workspaces autorizados, arquivos, Git, comandos, validações, tarefas em background e auditoria.

### `services/browser-worker`

Worker Windows de automação e diagnóstico do Chrome em sessão MCP isolada. Opera somente abas MCP-owned.

### `packages/mcp-core`

Contratos, schemas, políticas e registro compartilhado das ferramentas MCP.

## Runtime e operação

### `operations/runtime/gpt-mcp-proxy.mjs`

Proxy HTTP de rota única usado pela imagem Docker do Proxy.

### `operations/runtime/Initialize-GptOnlyProduction.ps1`

Gera configuração privada, tokens e diretórios necessários à implantação. Não inicia processos permanentes.

### `deploy/docker/scripts/Run-DockerHostComponent.mjs`

Runner task-owned do Workspace Agent e do Browser Worker. Mantém lease, reinício interno e encerramento do processo filho.

### `tooling/windows-host-launcher/McpNodeHostLauncher.cs`

Launcher Windows sem console. Inicia o runner Node, redireciona logs, propaga exit code e controla a árvore por Job Object.

## Dados privados

`.runtime-private/` contém credenciais e configurações locais. `runtime/` contém estado e logs. `.runtime-tools/` contém ferramentas e binários auxiliares. Nenhum desses diretórios é versionado.
