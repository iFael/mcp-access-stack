# Services

Processos executáveis da pilha. Cada serviço possui package próprio, build independente e contrato explícito.

- `mcp-gateway/`: endpoint MCP, autenticação, Actions e relay do runtime tradicional/remoto.
- `workspace-agent/`: acesso autorizado a arquivos, Git, comandos e validações.
- `browser-worker/`: automação segura de navegador com perfil persistente.
- `mcp-edge-gateway/`: Cloudflare Worker + Durable Object para a borda serverless e o canal outbound do futuro MCP Connector Windows.

Os nomes npm existentes foram preservados para manter compatibilidade com integrações atuais.
