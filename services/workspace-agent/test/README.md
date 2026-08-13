# Workspace Agent Tests

Os testes são classificados pelo comportamento executado, não apenas pelo arquivo de produção correspondente.

## Unit

Validam regras e transformações isoladas. Não sobem servidor, não executam Git, shell, ast-grep ou Gitleaks reais.

```bash
npm run test:workspace-agent:unit
```

## Integration

Validam módulos reais com filesystem temporário, repositórios Git locais, processos controlados, shells permitidos e ferramentas de validação instaladas. Não acessam serviços externos nem dados produtivos.

```bash
npm run test:workspace-agent:integration
```

## E2E

Validam o ciclo completo da conexão do agente, incluindo servidor WebSocket local, protocolo de relay, reconexão e processo standalone isolado.

```bash
npm run test:workspace-agent:e2e
```

## Regras de isolamento

- use diretórios temporários e portas dinâmicas;
- encerre servidores, sockets, timers e processos;
- restaure variáveis de ambiente alteradas;
- não leia `.runtime-private` nem credenciais produtivas;
- não execute comandos contra repositórios ou serviços externos;
- mantenha testes com infraestrutura real fora de `unit/`.
