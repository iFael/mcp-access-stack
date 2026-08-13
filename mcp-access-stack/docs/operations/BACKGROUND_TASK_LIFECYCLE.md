# Background task lifecycle

O `BackgroundTaskManager` fornece uma API única para comandos longos executados em workspaces autorizados:

```text
start_background_task
get_background_task
list_background_tasks
cancel_background_task
read_background_task_logs
```

## Estado persistido

Cada tarefa possui arquivos separados para estado, resultado, stdout e stderr. O registro JSON contém identificador, workspace, operação, hash de deduplicação, representação redigida do comando, shell, diretório, timeout, PID, timestamps, estado e resultado final.

Estados suportados:

```text
starting
running
succeeded
failed
cancelled
```

O resultado permanece consultável depois da recriação do processo chamador quando o mesmo diretório de estado é reutilizado. Arquivos de estado inválidos são movidos para quarentena.

## Deduplicação

Uma nova execução não é iniciada quando já existe uma tarefa `starting` ou `running` com a mesma combinação de:

```text
workspace + shell + cwd + comando executável
```

O hash usa o comando preservando espaços internos significativos. Comandos iguais em workspaces diferentes continuam independentes.

## Segurança do comando

A tarefa passa pelas mesmas políticas de workspace, shell, diretório e Git aplicadas aos comandos síncronos. Comandos classificados como destrutivos são recusados antes da criação da tarefa.

Tarefas em background não possuem fluxo interativo de confirmação. Um runner que retornar `confirmation_required` é tratado como falha de contrato.

## Logs

Stdout e stderr são persistidos separadamente. Padrões comuns de credenciais são redigidos antes da gravação física, com uma segunda sanitização defensiva ao concluir a execução.

`read_background_task_logs` limita a quantidade retornada a no máximo 1.000.000 bytes e informa o tamanho total e se houve truncamento da leitura.

## Cancelamento

O cancelamento persiste primeiro o estado terminal `cancelled` e depois encerra a árvore do processo. Isso impede que a rejeição causada pelo encerramento sobrescreva o estado com `failed`.

## Timeouts

A política aceita valores entre 30 segundos e 24 horas, com padrão de 120 segundos. Timeout e cancelamento solicitado pelo chamador possuem semânticas distintas: somente o primeiro produz `timedOut: true`.

## Recuperação

Ao carregar uma tarefa persistida em estado ativo, o manager verifica se o PID ainda existe. Quando o processo não existe, a tarefa é marcada como `failed` por interrupção do Agent.

A comprovação forte de ownership após reinício ainda depende de evolução futura para process handle ou Job Object; a existência isolada do PID não elimina o risco de reutilização.

## Concorrência

Criações são serializadas durante a deduplicação. Gravações são serializadas por identificador e usam arquivo temporário seguido de substituição, evitando JSON parcialmente escrito durante transições rápidas no Windows.
