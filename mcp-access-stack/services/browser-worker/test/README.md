# Browser Worker Tests

Os testes são classificados pelo comportamento executado, não pelo nome do módulo.

## Unit

Testam regras e transformações isoladas. Não sobem servidor, não usam navegador e não acessam filesystem real.

```bash
npm run test:browser-worker:unit
```

## Integration

Validam componentes reais trabalhando juntos com drivers controlados, filesystem temporário, sessões locais ou servidor HTTP local. Não acessam serviços externos nem abas pessoais.

```bash
npm run test:browser-worker:integration
```

## E2E

Validam fluxos completos pela interface pública do Browser Worker. O fluxo avançado sobe servidor HTTP, fila, runtime e driver simulado em recursos isolados.

```bash
npm run test:browser-worker:e2e
```

## Regras de isolamento

- use portas dinâmicas;
- encerre servidores, timers, sessões e processos;
- remova diretórios temporários;
- restaure variáveis de ambiente alteradas;
- use apenas abas e recursos MCP-owned;
- não leia `.runtime-private` nem configuração produtiva.
