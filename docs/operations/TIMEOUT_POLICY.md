# Política transversal de timeouts

## Objetivo

Esta política define como o MCP Access Stack limita, propaga, encerra e diagnostica operações em todas as camadas sem aumentar timeouts globalmente.

A regra principal é:

- operação rápida: timeout solicitado padrão de 60 segundos;
- operação média síncrona: timeout explícito de até 300 segundos;
- operação superior a 300 segundos: execução persistente pelo `BackgroundTaskManager`;
- cada camada interna usa o menor deadline absoluto restante;
- nenhuma camada reinicia uma janela completa depois que tempo já foi consumido externamente.

## Contrato compartilhado

O contrato de deadline registra:

- `requestedTimeoutMs`: timeout originalmente solicitado;
- `effectiveTimeoutMs`: janela efetiva disponível na camada atual;
- `deadlineAt`: deadline absoluto em UTC.

O diagnóstico de ciclo de vida acrescenta:

- `elapsedMs`: tempo consumido;
- `terminatedBy`: camada que encerrou a operação;
- `reason`: motivo terminal;
- `diagnostic`: informação curta e sanitizada.

Motivos terminais aceitos:

- `timeout`: a própria camada esgotou o deadline efetivo;
- `cancelled`: cancelamento explícito;
- `client_disconnected`: o cliente ou transporte upstream encerrou a chamada;
- `upstream_timeout`: uma camada externa encerrou a espera antes da interna;
- `process_failed`: o processo terminou com falha ou não pôde ser recuperado.

## Matriz das camadas

| Camada | Política efetiva | Encerramento e diagnóstico |
|---|---|---|
| ChatGPT / plataforma | limite externo, não configurável pelo repositório | pode encerrar antes do stack; classificado como camada `external` quando houver informação disponível |
| Handler MCP | cria o deadline a partir do timeout solicitado e combina o sinal do SDK, o registro stateless e o lifecycle HTTP | cancelamento é correlacionado por principal + JSON-RPC request ID; desconexão HTTP é identificada como `mcp_server/client_disconnected` |
| `run_command` / `run_powershell` | padrão 60 s; síncrono até 300 s; acima de 300 s é encaminhado ao background | o caminho direto rejeita qualquer bypass acima de 300 s |
| Validação e inspeção Git | padrão 60 s; máximo 300 s | usam o sinal do deadline e encerram a árvore do processo auxiliar |
| Gateway | padrão 60 s para o Agent; máximo 300 s | aplica o menor deadline restante; timeout upstream é preservado com lifecycle estruturado |
| GPT Actions HTTP | máximo 300 s por chamada síncrona | cria deadline e `AbortSignal`; timeout retorna lifecycle `http_server/timeout`; desconexão retorna `http_server/client_disconnected`; operações maiores recebem orientação para background |
| Relay WebSocket | transmite request, deadline e cancelamento explícito | timeout, cancelamento e desconexão geram mensagens de cancelamento ao Agent |
| Workspace Agent | usa o deadline absoluto recebido | deadline expirado é `workspace_agent/timeout`; cancelamento mantém o motivo original |
| Executor síncrono | recalcula o tempo restante antes de iniciar o processo | não aceita operação síncrona superior a 300 s |
| Processo filho | timer baseado no deadline efetivo | encerra a árvore; timeout é `child_process/timeout`; stdout e stderr parciais são preservados |
| HTTP Gateway → Browser Worker | máximo 300 s, conforme configuração do cliente | timeout é `http_client/upstream_timeout` e preserva lifecycle estruturado do Worker quando disponível |
| Browser Worker | operação normal até 180 s; diagnóstico até 300 s | timeout interno é `executor/timeout` |
| Proxy HTTP | envelope de até 300 s para receber a resposta inicial upstream | retorna HTTP 504 com `reason=upstream_timeout` e `terminatedBy=proxy`; streams já iniciados não recebem novo timer global |
| `BackgroundTaskManager` | timeout persistente explícito entre 30 s e 24 h; roteamento automático de comandos acima de 300 s | timeout, cancelamento, falha, resultado e logs são persistidos; tarefas ativas idênticas são deduplicadas |
| Task Scheduler / supervisor host | lifecycle do host ilimitado; não é timeout de operação | mantém Agent e Browser Worker vivos; shutdown usa período de graça e encerramento de árvore |
| Health checks e scripts operacionais | limites locais de observação | não substituem o deadline da operação principal |

## Antes e depois

| Aspecto | Antes | Depois |
|---|---|---|
| Default de comando síncrono | 120 s | 60 s |
| Teto do Gateway | 600 s | 300 s |
| Propagação | deadline parcial no relay, sem contrato uniforme | timeout solicitado, efetivo e deadline absoluto compartilhados |
| Cancelamento MCP | handler não propagava `extra.signal` e notificações stateless não alcançavam a instância original | registry transversal por principal + request ID; cancelamento explícito é enviado ao Agent e aborta a chamada HTTP Gateway → Browser Worker |
| Timeout do Gateway | removia a promise pendente | também cancela a execução ativa no Agent e preserva lifecycle quando disponível |
| GPT Actions HTTP | request podia continuar depois de timeout ou desconexão do cliente | deadline e cancelamento são propagados; timeout e desconexão são diferenciados |
| Diagnóstico | código genérico, sem camada responsável | `terminatedBy`, `reason`, `elapsedMs` e diagnóstico sanitizado |
| Git e validação | encerravam apenas o PID direto | encerram e aguardam a árvore de processos |
| Comando acima de 300 s | schema síncrono rejeitava ou exigia escolha manual | `run_command` e `run_powershell` encaminham automaticamente ao background |
| Retry de operação longa | risco de nova execução | tarefa persistente ativa é deduplicada pelo comando exato, workspace, shell e diretório |
| Proxy | sem timeout explícito de resposta inicial | 504 estruturado após o envelope configurado, sem reduzir timeouts explícitos médios |
| Espaços do comando | background aplicava `trim()` no schema | comando é preservado exatamente; apenas entrada composta somente por whitespace é inválida |

## Exemplos

### Operação rápida

Leitura, busca, inspeção curta ou comando simples:

```json
{
  "timeoutMs": 60000
}
```

A chamada permanece síncrona.

### Operação média

Teste ou validação determinística com duração conhecida inferior a cinco minutos:

```json
{
  "timeoutMs": 240000
}
```

A chamada permanece síncrona e todas as camadas respeitam o mesmo deadline absoluto.

### Operação longa

Build completo, release, soak, benchmark ou migração:

```json
{
  "timeoutMs": 900000
}
```

Ao usar `run_command` ou `run_powershell`, a ferramenta retorna `status=background_task_started` e o identificador persistente da tarefa. O cliente consulta estado, resultado e logs com as ferramentas do `BackgroundTaskManager`.

Chamadas GPT Actions HTTP permanecem limitadas a 300 segundos e devem orientar o consumidor a iniciar uma tarefa persistente para trabalhos mais longos.

## Timeout, cancelamento e desconexão

`timeout` significa que uma camada esgotou o deadline que ainda restava para ela. O processo é encerrado e o erro identifica essa camada.

`cancelled` significa que houve uma decisão explícita de interromper a operação. Esse estado não pode ser convertido em timeout ou falha genérica.

`client_disconnected` significa que a chamada upstream deixou de existir. O Gateway envia cancelamento ao Agent para impedir que a operação continue sem consumidor. No endpoint GPT Actions, esse caso é representado por HTTP 499 quando ainda é possível responder.

No transporte MCP HTTP stateless, cada POST pode criar uma nova instância de servidor e transporte. Por isso, `notifications/cancelled` é interceptada antes do dispatch do SDK e correlacionada em um registry compartilhado pela identidade autenticada do principal e pelo tipo/valor do JSON-RPC request ID. O registry não armazena token nem request ID em claro: ambos participam somente de chaves derivadas por hash. Uma notificação de outro principal não pode cancelar a operação ativa, mesmo reutilizando o mesmo request ID.

O lifecycle da requisição HTTP também participa do sinal combinado. Eventos `aborted` ou fechamento da resposta antes de `writableEnded` encerram a operação como `client_disconnected`. O término normal da resposta remove os listeners e libera o registro ativo.

`upstream_timeout` significa que uma camada externa desistiu de aguardar antes de a camada interna concluir. O diagnóstico preserva a camada que tomou a decisão.

## Encerramento da árvore

Shell, Git e validações usam o mesmo helper de encerramento:

- Windows: `taskkill /T /F`, aguardando a finalização;
- POSIX: `SIGTERM` no grupo e no PID, seguido de `SIGKILL` após o período de graça;
- o resultado ou erro só é concluído depois que a tentativa de encerramento da árvore termina;
- para comandos síncronos, Gateway e Agent mantêm uma janela técnica de até 30 segundos após o deadline de execução apenas para concluir o encerramento da árvore e devolver o resultado estruturado; essa janela não permite que o comando continue executando;
- timeout preserva stdout e stderr coletados até o encerramento;
- tarefas persistentes preservam arquivos físicos de stdout, stderr e resultado, com sanitização.

## Operações longas

1. Solicite timeout superior a 300 segundos em `run_command` ou `run_powershell`, ou use `start_background_task` diretamente.
2. Armazene o `task.id` retornado.
3. Consulte `get_background_task` ou `list_background_tasks`.
4. Leia logs incrementais com `read_background_task_logs`.
5. Cancele com `cancel_background_task` quando necessário.
6. Não repita o mesmo comando para contornar uma espera; uma tarefa ativa equivalente é retornada pela deduplicação.

## Diagnóstico

Para investigar uma falha, registre somente dados sanitizados:

- código do erro;
- `reason`;
- `terminatedBy`;
- timeout solicitado e efetivo;
- deadline absoluto;
- tempo decorrido;
- ID da requisição ou tarefa;
- estado persistido e tamanhos de stdout/stderr.

Não registrar:

- tokens ou headers de autorização;
- URLs privadas com query string;
- configuração privada;
- caminhos de perfil pessoal;
- conteúdo integral de comandos quando o log não exigir.

## Limites externos

O projeto não controla:

- timeout da chamada de ferramenta imposto pela plataforma ChatGPT;
- timeout de túnel, balanceador ou provedor externo fora da configuração do repositório;
- políticas do sistema operacional, antivírus ou infraestrutura corporativa;
- duração de operações remotas chamadas pelo processo filho.

Esses limites devem ser menores ou maiores de forma intencional. Quando forem menores que o deadline do stack, a operação deve terminar como desconexão ou timeout upstream, nunca como timeout interno inventado.

## Exceções aceitas

- o `BackgroundTaskManager` aceita até 24 horas porque a tarefa é persistente e não mantém chamada MCP ou HTTP síncrona aberta;
- o Task Scheduler usa `ExecutionTimeLimit` ilimitado porque controla o lifecycle permanente do host, não uma operação do usuário;
- streams MCP que já receberam resposta inicial não recebem timeout global do proxy; o timeout do proxy protege apenas a espera pela resposta inicial;
- Browser Worker mantém defaults médios de 90 a 120 segundos para navegação e diagnóstico, sempre abaixo do teto síncrono de 300 segundos.
