# Operações

- `runtime/`: geração de configuração privada, proxy MCP e testes relacionados.
- `browser/`: preparação e diagnóstico do perfil dedicado do navegador.
- `gpt-actions/`: configuração da superfície GPT Actions.
- `inspector/`: execução do MCP Inspector.
- `validation/`: instalação e verificação de ferramentas auxiliares.

Processos permanentes de produção não são iniciados por esta pasta. Containers são gerenciados em `deploy/docker/`, e os hosts Windows usam tarefas agendadas com launcher nativo.
