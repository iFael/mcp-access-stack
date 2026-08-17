# MCP Edge Gateway

Cloudflare Worker usado como borda pública serverless do MCP.

Topologia deste estágio:

```text
ChatGPT -> Cloudflare Worker -> Durable Object <-> MCP Connector (Windows, outbound)
```

O Worker é implantado **desativado por padrão** (`MCP_EDGE_ENABLED=false`). O endpoint `/mcp` só começa a encaminhar tráfego quando essa flag for explicitamente habilitada em um gate posterior.

## Rotas

- `GET /health`: saúde do Worker e presença de connector pronto.
- `POST /mcp`: relay MCP; retorna `503` enquanto o edge estiver desabilitado ou o connector não estiver pronto.
- `/connector`: upgrade WebSocket autenticado para o connector outbound do Windows.

## Segurança inicial

- `MCP_CONNECTOR_TOKEN` é obrigatório para `/connector` e deve ser criado como Cloudflare secret, nunca versionado.
- O token não é encaminhado ao Windows e não é registrado.
- O relay usa allowlist de headers e limites de tamanho/timeout.
- A ativação pública do `/mcp` fica separada da implantação inicial.

## Cloudflare Worker identity

O Worker conectado no dashboard chama-se `mcp-access-stack` e o campo `name` do `wrangler.jsonc` deve permanecer alinhado a esse nome.

## Cloudflare Workers Builds

Configuração do projeto conectado ao GitHub:

```text
Root directory: mcp-access-stack/services/mcp-edge-gateway
Build command:   (vazio)
Deploy command:  npx wrangler deploy
```

O `wrangler.jsonc` deste diretório é a fonte de verdade do Worker. O Durable Object usa armazenamento SQLite e WebSocket Hibernation para manter o connector conectado sem exigir uma VM dedicada.
