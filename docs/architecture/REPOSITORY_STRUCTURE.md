# Estrutura do repositório

A árvore é organizada por responsabilidade operacional, não por tecnologia genérica.

```text
services/
  browser-worker/        automação segura de navegador
  mcp-gateway/           MCP, autenticação, Actions e relay
    src/actions/          rotas, schemas, workflows e console das Actions
    src/relay/            WebSocket e requisições ao Workspace Agent
    src/auth/             OAuth/JWT
    src/browser/          cliente do Browser Worker
    src/http/             middlewares HTTP
    src/mcp/              servidor MCP
    test/{unit,integration,e2e}/
  workspace-agent/       arquivos, Git, shell e validações locais

packages/
  mcp-core/              contratos, tipos e políticas compartilhadas

operations/
  runtime/               configuração privada e proxy MCP
  browser/               confiabilidade e diagnóstico do navegador
  gpt-actions/           preparação da integração GPT Actions
  inspector/             MCP Inspector
  validation/            ferramentas de validação

deploy/
  docker/                imagens, Compose, releases e tarefas Windows

tooling/
  benchmarks/browser/    benchmark do fast path do navegador
  benchmarks/mcp/        benchmark MCP ponta a ponta
  smoke/browser/         smoke tests oficiais do Browser Worker
  structure/             validação estrutural do repositório

docs/
  architecture/          arquitetura e limites
  integrations/          integração com ChatGPT e hosts
  operations/            runbooks e confiabilidade
  security/              segurança e dados privados
```

## Regras de dependência

```text
services   ─┐
operations ├──> packages/mcp-core
 tooling   ┘
```

`packages/mcp-core` não pode importar serviços, deploy ou tooling. Serviços não devem importar implementações internas uns dos outros em produção; a comunicação ocorre pelos contratos HTTP, MCP ou relay. Imports cruzados diretos ficam restritos a testes de integração.

## Pacotes internos

- `@vs-code-gpt/browser-worker`;
- `@vs-code-gpt/remote-mcp-gateway`;
- `@vs-code-gpt/local-agent`;
- `@vs-code-gpt/shared`.

Os pacotes são privados e existem para organizar o monorepo e preservar contratos internos claros.

## Dados que não pertencem à árvore versionada

- `.runtime-private/`: tokens, URLs privadas, perfis e configuração produtiva;
- `runtime/`: estado, logs, auditoria e resultados de benchmark;
- `.runtime-tools/`: binários auxiliares instalados localmente;
- `releases/`: artefatos de release imutável.

Nenhum módulo deve gravar segredo dentro de `services/`, `packages/`, `operations/`, `deploy/`, `tooling/` ou `docs/`.
