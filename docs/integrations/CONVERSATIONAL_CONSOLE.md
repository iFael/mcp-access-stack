# Console Conversacional do LegacySite Dev

## Objetivo

O Console Conversacional fornece acompanhamento textual e auditável das tarefas executadas pelo GPT diretamente na conversa do ChatGPT.

Ele não cria uma interface gráfica customizada. O gateway retorna um painel em `consoleMarkdown`, pronto para ser apresentado no chat, contendo:

- execução e objetivo;
- workspace, raiz e branch;
- status e progresso;
- etapas concluídas, atual e pendentes;
- atividade operacional sanitizada;
- arquivos lidos ou alterados;
- validações;
- autorizações pendentes.

## Arquitetura

```text
LegacySite Dev
  -> GPT Actions
     -> Console Conversacional em memória
     -> operações existentes do MCP Access Stack
        -> local-agent
```

As execuções ficam somente na memória do `workspace-gateway`:

- não são gravadas em disco;
- expiram após oito horas sem atividade;
- são removidas quando o processo reinicia;
- possuem limite global e limite de eventos por execução;
- não armazenam conteúdo de arquivos, diffs, comandos, stdout, stderr, tokens ou segredos.

## Operações da Action

### `iniciarConsoleConversacional`

Cria uma execução e retorna um `runId` no formato:

```text
MT-AAAAMMDD-XXXXXXXXXXXXXXXX
```

Use no início de uma tarefa técnica que envolva investigação ou alteração de projeto.

### `atualizarConsoleConversacional`

Atualiza explicitamente:

- etapa;
- progresso;
- resumo operacional;
- branch;
- arquivos e contagens de linhas;
- validações;
- autorização pendente, aprovada ou rejeitada.

### `consultarConsoleConversacional`

Retorna o snapshot atual e o campo `consoleMarkdown`.

### `listarEventosDoConsoleConversacional`

Retorna eventos incrementais por `afterSequence`, sem payloads sensíveis.

### `concluirConsoleConversacional`

Finaliza como:

- `completed`;
- `failed`;
- `cancelled`.

## Rastreamento automático

Todas as operações POST existentes da GPT Action aceitam `runId` opcional.

Quando o `runId` é informado, o gateway registra automaticamente:

- início da operação;
- conclusão;
- falha e código de erro;
- arquivo lido em leitura individual ou em lote;
- arquivo criado ou alterado em escrita e patch;
- branch e caminhos retornados pela inspeção Git;
- resultado das validações estruturadas;
- confirmação pendente para comandos.

O rastreamento não altera a política de segurança, os payloads encaminhados ao agente nem o resultado funcional da operação.

## Instruções recomendadas para o GPT

Adicionar ao GPT `LegacySite Dev` após a publicação do schema 1.7.0:

```text
CONSOLE CONVERSACIONAL

Para toda tarefa que exija acessar ou alterar um projeto:
1. Inicie uma execução com iniciarConsoleConversacional assim que identificar workspace, raiz e objetivo.
2. Reutilize o runId em todas as operações POST da Action durante a tarefa.
3. Mostre o consoleMarkdown após o início, após mudanças relevantes de etapa, antes de solicitar autorização e na conclusão. Não publique uma nova atualização para cada leitura pequena.
4. Use atualizarConsoleConversacional para registrar planejamento, implementação, validações, arquivos, branch e autorizações que não forem inferidos automaticamente.
5. Antes de pedir autorização para commit, push, comando sensível ou deploy, registre approval com state=required e apresente o consoleMarkdown.
6. Depois da resposta do usuário, registre approval como approved ou rejected antes de prosseguir.
7. Finalize com concluirConsoleConversacional somente após a revisão final. Use completed, failed ou cancelled conforme o resultado real.
8. Nunca inclua no objetivo, resumo, labels ou eventos tokens, segredos, conteúdo integral de arquivos, diffs integrais, comandos completos, stdout ou stderr.
9. O console é acompanhamento operacional. Ele não substitui as seções finais Alterações, Testes, Git e Pendências.
```

## Exemplo de fluxo

```text
iniciarConsoleConversacional
  -> prepararTarefaNoEspacoDeTrabalho(runId)
  -> consultarConsoleConversacional
  -> leituras e buscas(runId)
  -> atualizarConsoleConversacional(stage=implementation)
  -> patches e escritas(runId)
  -> atualizarConsoleConversacional(stage=validation)
  -> validações(runId)
  -> validarAlteracoesDoEspacoDeTrabalho(runId)
  -> atualizarConsoleConversacional(stage=git)
  -> inspecionarGitDoEspacoDeTrabalho(runId)
  -> concluirConsoleConversacional
```

## Limitações

- Não existe atualização visual em streaming de uma mensagem anterior.
- Cada atualização relevante aparece como uma nova resposta do GPT.
- O cancelamento do console não interrompe uma requisição síncrona que já esteja em execução.
- Após restart do gateway, uma execução anterior retorna `EXECUTION_NOT_FOUND` e deve ser reiniciada.
- O console não executa commit, push, deploy ou comando; ele apenas acompanha as operações já existentes.
