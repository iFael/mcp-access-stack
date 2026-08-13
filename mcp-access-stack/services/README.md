# Services

Processos executáveis da pilha. Cada serviço possui package próprio, build independente e contrato explícito com `packages/mcp-core`.

- `mcp-gateway/`: endpoint MCP, autenticação, Actions e relay.
- `workspace-agent/`: acesso autorizado a arquivos, Git, comandos e validações.
- `browser-worker/`: automação segura de navegador com perfil persistente.

Os nomes npm foram preservados para manter compatibilidade com integrações existentes.
