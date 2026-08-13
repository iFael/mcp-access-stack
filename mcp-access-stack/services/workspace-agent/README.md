# Workspace Agent

Executa operações locais somente em workspaces autorizados.

## Responsabilidades

- leitura, busca, patch e criação controlada de arquivos;
- inspeção Git e política de push;
- comandos com classificação de risco e confirmação;
- validações registradas, incluindo legado LegacySite e secret scan;
- auditoria sanitizada.

## Estrutura

```text
src/
├── connection/   # WebSocket, dispatch e lifecycle de requisições
├── filesystem/   # fachada, descoberta, busca, encoding e escrita textual
├── git/          # fachada, status e execução controlada de processos Git
├── shell/        # fachada, risco, confirmações e execução de processos
├── validation/   # orquestrador, validadores e infraestrutura de validação
├── local-agent.ts
├── path-security.ts
└── ...

test/
├── unit/         # regras e transformações isoladas
├── integration/  # filesystem, Git, shell e ferramentas reais controladas
├── e2e/          # WebSocket, relay e processo standalone
└── support/      # fixtures compartilhadas
```

A organização é baseada em responsabilidade e comportamento. Arquivos não devem ser movidos para novas camadas apenas para reduzir tamanho.

## Desenvolvimento

```bash
npm run build -w @vs-code-gpt/local-agent
npm run validation:tools:check
npm run test:workspace-agent
npm run test:workspace-agent:unit
npm run test:workspace-agent:integration
npm run test:workspace-agent:e2e
```

Políticas locais e caminhos privados não devem ser versionados.
