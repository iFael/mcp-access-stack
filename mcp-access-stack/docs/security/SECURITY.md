# Segurança GPT-only

## Segredos

Configurações privadas e tokens ficam fora do Git. Diagnósticos devem mostrar apenas estado sanitizado, nunca valores de credenciais.

## Acesso a workspaces

O agente local aplica allowlist, caminhos bloqueados, limites de tamanho, políticas de escrita, auditoria e confirmação para comandos potencialmente destrutivos.

## Browser Worker

O navegador usa sessão MCP isolada. Somente abas registradas como pertencentes ao MCP podem ser manipuladas; abas desconhecidas continuam pertencendo ao usuário.

## Rede

O proxy publica somente a rota MCP configurada. Gateway e Browser Worker permanecem locais. As portas legadas `3320`, `3330` e `3340` devem permanecer fechadas.

## Inicialização

O launcher com `--wait` retorna sucesso somente quando os cinco processos GPT-only estão saudáveis, permitindo que o Agendador repita inicializações que falharem.

## Dependências

A auditoria de dependências de produção deve ser revisada antes de cada release Docker.

Em 2026-07-24:

- `fast-uri` foi fixado em `3.1.4`, removendo o advisory de severidade alta dentro da faixa compatível do AJV;
- permanece um advisory moderado em `@hono/node-server` 1.x, dependência transitiva de `@modelcontextprotocol/sdk` 1.29.0;
- o SDK MCP já está na versão atual usada pelo projeto e declara `@hono/node-server` como `^1.19.9`;
- a correção disponível exige `@hono/node-server` 2.x ou downgrade do SDK, ambos fora da faixa suportada atual.

O projeto não importa `@hono/node-server` diretamente e não usa o `serve-static` do Hono. As superfícies HTTP próprias são montadas com Express. Por isso, não deve ser aplicado override de major nem downgrade automático do SDK apenas para silenciar o audit. O risco deve permanecer documentado e ser removido assim que o SDK publicar uma faixa compatível corrigida.

## Componentes ausentes

A produção não contém ferramentas `collab_*`, bridges, runners, orquestradores ou configuração automática de Cursor/Codex.
