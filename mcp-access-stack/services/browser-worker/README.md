# Browser Worker

Serviço HTTP local responsável pela automação de navegador.

## Capacidades

- Chromium gerenciado, fixado e executado em perfil dedicado persistente;
- propriedade exclusiva de abas;
- fila serial por aba, concorrência limitada entre abas e recuperação de bindings;
- referências ARIA diretas e snapshots semânticos incrementais com fallback;
- estado atualizado devolvido junto de clique, preenchimento, tecla, espera e navegação;
- frames Playwright nativos, inclusive cross-origin, com resumo híbrido para páginas legadas;
- idempotência de cinco minutos para impedir repetição de ações mutáveis;
- cache semântico de navegação por propósito;
- `browser_sequence` para executar até vinte passos tipados com uma única seleção de aba;
- console, rede, trace, PDF e vídeo dinâmico via screencast CDP;
- auditoria sem conteúdo, valores de formulário ou credenciais.

## Estrutura interna

```text
server.ts                     composition root e entrypoint estável
config/                       leitura e validação da configuração
controllers/                  transporte HTTP e despacho público
domain/                       sessões, abas, cache e confirmações
drivers/direct/               kernel Playwright, artefatos e snapshot incremental
infrastructure/               auditoria e persistência operacional
policies/                     modos e autorização de operações
services/                     orquestração e casos de uso
test/unit/                    regras isoladas e determinísticas
test/integration/             componentes reais com recursos locais
test/e2e/                     fluxos completos pela API pública
```

`server.ts` permanece na raiz para preservar o entrypoint `dist/server.js`. A estrutura não utiliza uma camada `controller/service` artificial para todos os arquivos; cada módulo fica no domínio correspondente à sua responsabilidade.

## Desenvolvimento

```bash
npm run build -w @vs-code-gpt/browser-worker
npm run test:browser-worker:unit
npm run test:browser-worker:integration
npm run test:browser-worker:e2e
npm run test:browser-worker:coverage
```

A configuração produtiva é privada. Não a copie para o repositório nem reutilize o perfil pessoal do Chrome. O runtime final não depende de `@playwright/mcp`, `@playwright/cli` ou da Playwright Extension.
