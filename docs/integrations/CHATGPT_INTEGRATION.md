# Integração com ChatGPT

A pilha pode ser integrada ao ChatGPT por duas superfícies independentes.

## MCP

Use MCP quando o plano e o cliente permitirem um servidor MCP personalizado.

Fluxo:

```text
ChatGPT
  -> túnel HTTPS
  -> gpt-mcp-proxy
  -> mcp-gateway
  -> workspace-agent / browser-worker
```

Componentes necessários:

- `services/mcp-gateway`;
- `services/workspace-agent`;
- `packages/mcp-core`;
- `operations/runtime`;
- `services/browser-worker`, somente quando automação de navegador for necessária.

O endpoint público deve expor apenas a rota MCP configurada. Tokens, políticas e URL de túnel permanecem em `.runtime-private`.

## GPT Actions

Use GPT Actions para um GPT privado baseado em OpenAPI.

A fachada está em `services/mcp-gateway/src/actions/service.ts` e reutiliza o mesmo relay e as mesmas políticas do MCP. Ela não concede acesso direto ao filesystem.

Preparação local:

```bash
npm run actions:init
```

Depois:

1. configure autenticação Bearer no editor do GPT;
2. importe o schema OpenAPI versionado;
3. mantenha o GPT como privado durante homologação;
4. valide primeiro operações somente leitura;
5. habilite escrita somente com políticas e confirmações revisadas.

## Console Conversacional

O Console Conversacional acompanha uma execução por `runId`. Ele registra somente metadados sanitizados e não substitui autorização de escrita, shell, Git ou deploy.

Consulte `CONVERSATIONAL_CONSOLE.md` para o fluxo completo.

## Navegador

O Browser Worker usa um Chrome dedicado e persistente. O ChatGPT não acessa o Chrome pessoal. As ferramentas de navegador são expostas pelo MCP Gateway e usam:

- abas MCP-owned;
- serialização por aba com concorrência limitada entre abas;
- confirmações para ações perigosas;
- cache semântico de navegação;
- snapshot incremental e estado devolvido pela própria ação;
- `browser_sequence` para ações compostas;
- engine ativo desde o login, com limpeza explícita das abas da tarefa.

## Checklist para distribuir a outras pessoas

- gerar configuração privada individual, nunca reutilizar tokens;
- revisar a allowlist de workspaces;
- criar perfil Chrome dedicado individual;
- manter `main` protegida no provedor Git;
- executar `npm ci` e `npm run check`;
- validar o endpoint MCP com `npm run inspector:mcp:list`;
- executar smoke tests somente leitura antes de liberar escrita;
- documentar quais componentes serão instalados naquele computador.
