# MCP Gateway

Expõe MCP, autentica clientes, publica GPT Actions e encaminha operações para o Workspace Agent e o Browser Worker.

## Entradas

- MCP Streamable HTTP;
- relay WebSocket do agente;
- fachada REST privada das GPT Actions;
- OAuth do proprietário quando habilitado.

## Estrutura

```text
src/
├── actions/       # rotas, schemas, workflows, console e OpenAPI das GPT Actions
├── relay/         # WebSocket do agente, requisições pendentes e executor de workspace
├── auth/          # JWT OAuth e fluxo OAuth do proprietário
├── browser/       # cliente HTTP do Browser Worker
├── http/          # middlewares MCP
├── mcp/           # criação do servidor MCP e compatibilidade de tools/list
├── app.ts         # composição da aplicação Express
├── config.ts
├── logger.ts
├── server.ts
└── index.ts

test/
├── unit/
├── integration/
├── e2e/
└── support/
```

A organização é baseada em responsabilidade. Arquivos declarativos, como a especificação OpenAPI, não devem ser fragmentados apenas por tamanho.

## Desenvolvimento

```bash
npm run build -w @vs-code-gpt/remote-mcp-gateway
npm run test:mcp-gateway
npm run test:mcp-gateway:unit
npm run test:mcp-gateway:integration
npm run test:mcp-gateway:e2e
```

O gateway não acessa o sistema de arquivos diretamente; operações de workspace são executadas pelo agente autorizado.
