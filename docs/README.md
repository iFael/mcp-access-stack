# Documentação

- `architecture/`: visão da pilha, limites, componentes e estrutura do repositório.
- `integrations/`: contratos e guias para integrar ChatGPT e outros hosts.
- `operations/`: produção, observabilidade, Browser Worker e recuperação.
- `security/`: modelo de confiança, autorização e dados privados.

Comece por `architecture/ARCHITECTURE.md` e depois use o runbook correspondente ao componente que será instalado.

## Percursos recomendados

- Novo mantenedor: `architecture/REPOSITORY_STRUCTURE.md`.
- Browser Engine v2: `architecture/BROWSER_ENGINE_V2.md`.
- Integração com ChatGPT: `integrations/CHATGPT_INTEGRATION.md`.
- Operação produtiva: `operations/RUNBOOK.md`.
- Atualização dos hosts Windows: `operations/HOST_RELEASE_LIFECYCLE.md`.
- Browser Worker: `operations/BROWSER_WORKER_RELIABILITY.md`.
- Benchmarks de fluxo do navegador: `operations/BROWSER_FLOW_BENCHMARKS.md`.
- Timeouts e operações longas: `operations/TIMEOUT_POLICY.md`.
- Rollout do command engine qualificado: `operations/QUALIFIED_COMMAND_ROLLOUT.md`.
- Segurança: `security/SECURITY.md`.
