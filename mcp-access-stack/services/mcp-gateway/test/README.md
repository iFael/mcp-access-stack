# MCP Gateway tests

Os testes são classificados pelo comportamento e pelos recursos utilizados.

## Unit

`test/unit/` contém regras, transformações e contratos isolados:

- configuração e validação de ambiente;
- JWT com chaves locais em memória;
- schemas e helpers de GPT Actions;
- estado, renderer e projeções do console;
- request manager do relay;
- helpers de middleware sem servidor real.

## Integration

`test/integration/` contém interação entre módulos e infraestrutura local controlada:

- HTTP Express real em porta efêmera;
- WebSocket real do relay;
- cliente do Browser Worker contra servidor HTTP local;
- SDK MCP com transporte em memória;
- fachada HTTP das GPT Actions.

## E2E

`test/e2e/` contém o fluxo completo Gateway → relay WebSocket → Workspace Agent.

## Support

`test/support/` contém fixtures compartilhadas. Arquivos desse diretório não são suítes Jest.

## Comandos

```bash
npm run test:mcp-gateway
npm run test:mcp-gateway:unit
npm run test:mcp-gateway:integration
npm run test:mcp-gateway:e2e
```
