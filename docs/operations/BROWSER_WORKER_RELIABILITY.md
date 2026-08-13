# Browser Worker — confiabilidade e eficiência

## Objetivo

O Browser Worker deve oferecer uma sessão de navegação previsível para o agente, com comportamento próximo ao de um navegador integrado de IDE:

- uma operação por vez sobre o contexto compartilhado do Chrome;
- identificadores lógicos de abas estáveis;
- reutilização de abas compatíveis;
- reconexão automática quando for segura;
- nenhuma repetição automática de ação mutável;
- crescimento de recursos limitado;
- diagnóstico mensurável por operação.

A segurança continua prioritária: uma aba pessoal nunca pode ser adotada apenas para fazer uma operação funcionar.

## Evidência histórica

O audit log disponível antes desta revisão continha 93 operações:

- 87 permitidas;
- 6 erros, taxa histórica de 6,45%;
- 5 `RELAY_PROTOCOL_ERROR`;
- 1 `TAB_NOT_FOUND`;
- 3 falhas em 12 conexões;
- uma falha de screenshot após aproximadamente dez segundos;
- oito chamadas de abertura e seis fechamentos.

O log de supervisão mostra muitos inícios do Browser Worker, mas a maior parte está associada a paradas e reinícios controlados da pilha. Portanto, a repetição de linhas `browser_worker_started` não prova, isoladamente, que o processo esteja caindo espontaneamente.

## Causas confirmadas

### 1. Operações concorrentes sobre um estado global

O Playwright MCP utiliza uma aba corrente compartilhada. Antes desta revisão, duas requisições HTTP podiam executar simultaneamente:

```text
requisição A seleciona aba A
requisição B seleciona aba B
requisição A continua e atua na aba B
```

Além de instabilidade, isso poderia produzir erros de propriedade de aba ou ações no contexto incorreto.

### 2. Identidade remota baseada no índice da aba

O vínculo remoto usava um identificador derivado do índice retornado pelo Chrome. Fechar ou inserir uma aba pode renumerar os índices. Uma aba legítima continuava aberta, mas o vínculo passava a apontar para outra posição, resultando em `TAB_NOT_FOUND`.

### 3. `browser_open` sempre criava uma nova aba

A conexão inicial já cria uma aba MCP vazia. Mesmo assim, a abertura seguinte criava outra aba. Repetir uma tarefa ou refazer uma operação criava novas abas, ainda que uma aba reutilizável ou a mesma URL já estivesse disponível.

### 4. Conexão explicitamente obrigatória

As operações exigiam uma chamada prévia a `browser_connect`. Uma desconexão transitória obrigava o agente a descobrir o estado, conectar e repetir manualmente a operação.

### 5. Ausência de recuperação seletiva

Uma falha de transporte encerrava a sessão. Não existia nova tentativa automática nem mesmo para operações seguras, como listar abas ou obter snapshot. Repetir indiscriminadamente também não seria aceitável, pois cliques, preenchimentos e uploads podem duplicar efeitos.

### 6. Observabilidade insuficiente

O audit log registrava operação, duração e erro, mas não registrava o tempo aguardado na fila. Também não existia um relatório reproduzível de taxa de erro e percentis de latência.

## Melhorias implementadas

### Serialização por aba

Todas as operações públicas passam por uma fila serial identificada pelo `tabId`. Ações na mesma aba preservam ordem estrita; abas diferentes podem progredir em paralelo, com limite padrão de quatro. O lock global fica restrito ao ciclo de vida do contexto e às configurações do perfil.

Se uma requisição expirar enquanto uma ação real ainda estiver em execução, a resposta é encerrada, mas a fila daquela aba continua bloqueada até a ação subjacente terminar. Isso impede concorrência com uma ação atrasada sem bloquear outras abas.

Uma operação que expira antes de iniciar é descartada e nunca executa posteriormente.

### Auto-conexão

As operações que precisam do navegador chamam internamente o mecanismo de conexão. `browser_connect` continua disponível, mas deixa de ser uma etapa obrigatória para o uso normal.

O mecanismo de conexão:

- agrupa chamadas concorrentes em uma única tentativa;
- tenta conectar até três vezes em falhas transitórias;
- usa espera curta e limitada entre tentativas;
- não repete erro estrutural de ferramentas ausentes.

### Retry somente para operações seguras

Uma nova tentativa automática após desconexão é permitida apenas para:

- snapshot;
- espera;
- listagem de abas;
- seleção de aba.

Não são repetidos automaticamente:

- abrir ou fechar aba;
- navegar;
- clicar;
- preencher;
- pressionar tecla;
- avaliar JavaScript;
- upload;
- screenshot e demais ações com efeito ou artefato.

Essa separação evita duplicidade de efeitos.

### Reutilização determinística de abas

`browser_open` agora segue esta ordem:

1. reconciliar vínculos atuais;
2. reutilizar a mesma URL quando a aba for compatível;
3. reutilizar a aba padrão vazia;
4. reutilizar a aba não protegida menos recentemente usada;
5. criar uma nova aba apenas quando necessário.

Para exigir uma aba separada, o chamador deve usar `reusable=false`.

O LegacySite continua em aba protegida e sticky. A chamada repetida para a URL principal reutiliza a aba sticky existente.

### Limite de abas MCP

Foi criado `BROWSER_WORKER_MAX_OWNED_TABS`, com padrão de oito abas e faixa permitida de 1 a 100.

Ao atingir o limite, a abertura de uma aba obrigatoriamente distinta falha com `LIMIT_EXCEEDED`, em vez de crescer sem controle.

### Recuperação segura após renumeração

Quando o índice salvo não corresponde mais à aba, o worker procura uma única candidata que tenha simultaneamente:

- URL normalizada idêntica;
- título idêntico;
- índice não reivindicado por outra aba MCP;
- aba não quebrada.

Somente uma correspondência inequívoca é aceita. URL isolada, título isolado ou aba pessoal arbitrária não são suficientes. O novo índice é persistido após a recuperação.

### Menos chamadas redundantes

A lista remota obtida durante a reconciliação de `browser_open` é reutilizada na seleção feita na mesma operação. Isso remove uma consulta redundante ao Playwright MCP e reduz a janela para mudança de estado entre duas leituras.

### Auditoria mensurável

O audit log passa a registrar `queueWaitMs` nas operações concluídas.

O comando abaixo produz um resumo sanitizado com taxa de erro, motivos, p50, p95, máximo e p95 de fila:

```text
npm run browser:reliability:report
```

O relatório não inclui URL, conteúdo da página, comandos, credenciais ou payloads.

## Validação automatizada

O conjunto direcionado pode ser executado com:

```text
npm run browser:reliability:test
```

Os cenários cobertos incluem:

- rajada de 40 operações mantendo concorrência máxima igual a um;
- ordem FIFO;
- descarte de operação que expirou na fila;
- duas requisições HTTP concorrentes sem sobreposição;
- timeout da primeira operação sem liberação prematura da fila;
- auto-conexão;
- reutilização da aba padrão;
- abertura repetida da mesma URL sem duplicação;
- recuperação após renumeração de índice;
- limite de abas não reutilizáveis;
- política de retry seguro e de não retry mutável;
- configuração do limite de abas;
- contratos MCP e upload existente.

## Critérios para homologação integrada

Após autorização para reiniciar a pilha com esta versão, executar um soak test controlado:

1. confirmar um único processo Browser Worker saudável;
2. executar 20 ciclos de `status`, `tabs`, `open` da mesma URL e `snapshot`;
3. confirmar que a quantidade de abas MCP permanece constante;
4. fechar uma aba anterior no Chrome e confirmar recuperação de índice sem abrir substituta desnecessária;
5. simular uma reconexão da extensão e confirmar recuperação de leitura;
6. confirmar que ação mutável não é repetida automaticamente;
7. gerar o relatório de confiabilidade;
8. exigir taxa de erro igual a zero no cenário controlado;
9. confirmar p95 de espera em fila compatível com a duração das operações anteriores;
10. confirmar ausência de ação sobre aba pessoal.

## Limitações residuais

O protocolo oficial de abas expõe índices, não um identificador persistente próprio do Chrome. A recuperação por URL e título é uma compensação segura, mas não pode distinguir duas abas idênticas. Nesse caso, o worker falha de forma fechada e exige uma nova aba MCP explícita.

Uma operação do navegador não pode ser cancelada à força com garantia depois de enviada ao Playwright. Por isso, o timeout encerra a resposta, mas mantém a fila ocupada até a ação real terminar.

A homologação integrada depende de reinício controlado da pilha. Código aprovado em testes locais não equivale a validação da extensão, do Chrome e do perfil autenticado em execução real.

## Resultado da homologação produtiva

A homologação foi executada em 2026-07-23 após reinício autorizado da pilha.

Resultados do soak principal:

```text
89 operações reais
20 ciclos sequenciais de open/snapshot/tabs
20 requisições concorrentes
0 erros
0 recusas
mesma aba reutilizada nos 20 ciclos
pico de 3 abas durante o teste de renumeração
1 aba MCP ao final
screenshot aprovado
recuperação de índice aprovada
```

A espera p95 em fila foi aproximadamente 2,58 segundos durante a rajada concorrente, compatível com a serialização das operações anteriores. A duração máxima observada foi aproximadamente 3,33 segundos.

A recuperação de processo também foi exercitada: somente o PID registrado do Browser Worker foi encerrado. O runner task-owned iniciou outro processo e incrementou sua tentativa de reinício sem criar um segundo Browser Worker.

A amostra pós-recuperação executou treze operações, sem erro ou recusa, reutilizou a mesma aba e terminou com uma única aba MCP.

A queda completa do processo não preserva a página ativa anterior. O vínculo inexistente é descartado e uma única aba padrão é criada. Esse comportamento evita adoção acidental de aba pessoal, mas não oferece continuidade de navegação entre processos.

## Migração para Chrome dedicado persistente

### Baseline antes do corte

Foi capturada uma janela nova, sem misturar o histórico anterior:

| Operação | Quantidade |
|---|---:|
| status | 12 |
| tabs | 24 |
| open | 12 |
| snapshot | 24 |
| extract | 24 |
| wait | 12 |
| navigate | 12 |
| **Total** | **120** |

Resultado: 120 permitidas, zero erros, zero recusas e taxa de erro de 0%.

### Arquitetura adotada

O modo produtivo usa um Chromium headed gerenciado, iniciado diretamente pelo Playwright com perfil persistente dedicado. Ele não usa Playwright MCP, Playwright CLI, Playwright Extension nem o perfil pessoal.

A configuração final aceita somente `persistent`. O rollback troca a release imutável inteira; não mantém um segundo motor dentro da release ativa.

No modo persistente, o diretório do perfil deve ficar dentro da área privada do Browser Worker. Essa regra é verificada ao carregar a configuração, evitando que uma configuração incorreta aponte para o perfil pessoal.

### Continuidade

Um smoke isolado iniciou o Browser Worker duas vezes com o mesmo perfil e registro. A segunda inicialização restaurou:

- o mesmo `tabId` lógico;
- a mesma URL;
- uma única aba;
- snapshots funcionais;
- zero páginas `chrome-extension://`.

Em produção, mortes controladas do Browser Worker foram recuperadas pelo runner task-owned sem duplicação do navegador dedicado. A aba do LegacySite foi restaurada com o mesmo identificador, sticky, protegida e travada na URL configurada.

### Baseline depois do corte

A mesma distribuição de 120 operações foi executada no Chrome persistente:

| Operação | p95 | Erros |
|---|---:|---:|
| status | 0,990 ms | 0 |
| tabs | 201,597 ms | 0 |
| open | 607,570 ms | 0 |
| snapshot | 582,508 ms | 0 |
| extract | 1.011,193 ms | 0 |
| wait | 443,252 ms | 0 |
| navigate | 511,045 ms | 0 |

Resultado: 120 permitidas, zero erros, zero recusas e taxa de erro de 0%. A espera p95 de fila ficou abaixo de 0,2 ms em todas as operações.

### Relatório padrão

`npm run browser:reliability:report` resolve primeiro o audit log indicado pela configuração privada de produção. Quando ela não existe, usa o log de desenvolvimento em `runtime/browser`. Um caminho explícito continua tendo precedência.

### Estado operacional

- perfil: `dedicated-persistent`;
- extensão: desativada para a produção;
- Chrome pessoal: fora do contexto de automação;
- aba final: uma única aba protegida do LegacySite;
- autenticação: deve ser feita manualmente uma vez no perfil dedicado, sem copiar dados do perfil pessoal.

## Ciclo de vida orientado à tarefa

O navegador não é fechado por tempo ocioso. O fechamento depende da transição explícita da tarefa para um estado terminal.

| Situação | Comportamento |
|---|---|
| Operação em andamento | mantém o Chrome aberto |
| Pausa temporária | mantém abas e sessão abertas |
| Aguardando confirmação | mantém o Chrome aberto |
| Tarefa concluída, falha ou cancelada | fecha o contexto dedicado |
| Próxima tarefa | reabre com o mesmo perfil persistente |

A página `about:blank` é uma página de bootstrap do contexto persistente. O runtime agora fecha páginas vazias não reivindicadas quando já existe uma página útil, evitando a duplicação observada ao lado da aba do LegacySite.

A API de `createConnection` do Playwright MCP não fecha o navegador ao ser descartada. Por isso, o Browser Worker cria o `BrowserContext` persistente diretamente e o fornece à camada MCP. Essa propriedade explícita permite encerrar efetivamente a janela e confirmar a disponibilidade do perfil antes da próxima tarefa.

O smoke real do lifecycle verificou restart, restauração do mesmo `tabId`, remoção da aba vazia, fechamento completo em 274 ms e reabertura imediata de uma tarefa seguinte com uma única aba útil.
