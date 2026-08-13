# Smoke tests

Testes de integração reais que validam componentes compilados e recursos externos ao processo de testes unitários.

Esses testes não participam do runtime produtivo e não são executados por `npm run check`, porque iniciam processos isolados, abrem um navegador real e geram artefatos temporários.

## Browser avançado via MCP

```bash
npm run smoke:browser:advanced
```

Valida o caminho completo:

```text
cliente MCP -> gateway isolado -> Browser Worker isolado -> Playwright direto
```

A execução verifica:

- publicação das ferramentas avançadas do navegador;
- console e rede;
- trace, vídeo e PDF;
- métricas de readiness;
- propriedade MCP das abas;
- armazenamento privado dos artefatos;
- limpeza da sessão;
- encerramento dos processos e liberação das portas.

## Browser avançado direto

```bash
npm run smoke:browser:advanced:direct
```

Executa o mesmo canário diretamente contra um Browser Worker isolado, sem subir o gateway MCP intermediário.

## Isolamento

Os canários usam:

- portas efêmeras;
- servidor HTTP local como fixture;
- perfil Playwright temporário;
- diretórios temporários para runtime e artefatos;
- tokens gerados por execução.

Eles não usam portas, tokens, perfil do navegador ou diretórios privados da produção.

## Pré-requisitos

- Node.js compatível com o projeto;
- dependências instaladas com `npm ci`;
- Chromium gerenciado e FFmpeg do Playwright disponíveis.

Os comandos executam o build antes do canário para garantir que os serviços isolados usem os artefatos compilados atuais.
