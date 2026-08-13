# Tooling

Ferramentas de desenvolvimento e medição que não participam do runtime produtivo.

- `benchmarks/browser/`: comparação entre chamadas individuais e `browser_sequence`.
- `benchmarks/mcp/`: benchmark de ponta a ponta de ferramentas MCP com relatórios sanitizados.
- `smoke/`: canários de integração reais, isolados do runtime produtivo.

Resultados devem ser gravados em `runtime/` ou diretórios temporários e nunca versionados.
