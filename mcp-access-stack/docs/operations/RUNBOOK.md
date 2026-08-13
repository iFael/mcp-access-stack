# Runbook operacional

## Estado esperado

```text
Containers:
- mcp-access-tunnel
- mcp-access-proxy
- mcp-access-gateway

Tarefas Windows:
- MCP Access Stack Docker production agent
- MCP Access Stack Docker production browser-worker
```

Os containers executam Tunnel, Proxy e Gateway. As tarefas Windows executam launcher nativo, runner Node e o componente correspondente.

## Verificação rápida

```powershell
npm run docker:production:status
docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"
curl.exe -fsS http://127.0.0.1:3310/health/ready
curl.exe -fsS http://127.0.0.1:3350/health/live
curl.exe -fsS http://127.0.0.1:3350/health/ready
```

O status não deve imprimir tokens, URLs privadas ou conteúdo de configuração.

## Inicialização de configuração

```powershell
npm run production:init -- -PublicBaseUrl <url> -TunnelExecutable <ngrok.exe>
npm run validation:tools:init
npm run docker:production:init
```

O inicializador cria configuração e credenciais privadas. Ele não inicia um supervisor local.

## Reinício de componente host

Reinicie somente a tarefa afetada. Não encerre processos por nome e não reinicie containers quando a falha estiver restrita ao Agent ou Browser Worker.

```powershell
Stop-ScheduledTask -TaskName 'MCP Access Stack Docker production agent'
Start-ScheduledTask -TaskName 'MCP Access Stack Docker production agent'
```

Para o Browser Worker, use a tarefa correspondente e confirme a reconexão ao Chrome.

## Reinício de containers

Use Docker Compose somente quando Gateway, Proxy ou Tunnel precisarem ser reiniciados.

```powershell
docker compose `
  --env-file .runtime-private/docker/production/compose.env `
  -f deploy/docker/compose.production.yml `
  ps
```

Antes de qualquer `down`, confirme impacto, backup e estratégia de recuperação.

## Logs

- Hosts: `runtime/windows-services/production/<component>/`;
- builds de release: `runtime/release-build/`;
- Docker: `docker logs <container>`;
- auditoria: diretório privado configurado para cada componente.

Nunca copie logs brutos para documentação ou commits sem sanitização.

## Falha do Agent

1. conferir tarefa, runner lease e processo filho;
2. validar a configuração privada do Agent;
3. confirmar conexão do Gateway;
4. reiniciar somente a tarefa do Agent;
5. validar `3310/health/ready`.

## Falha do Browser Worker

1. conferir tarefa, runner lease e processo filho;
2. validar `3350/health/live` e `3350/health/ready`;
3. confirmar Chrome e perfil MCP dedicado;
4. reiniciar somente a tarefa do Browser Worker;
5. executar a operação de conexão do Browser Worker.

## Falha de Docker Desktop

Se `docker version` não apresentar o servidor ou mencionar o pipe `dockerDesktopLinuxEngine`, aguarde o Docker Desktop ficar disponível antes de diagnosticar o MCP.

## Diagnóstico de timeout

Consulte `TIMEOUT_POLICY.md` e registre:

- código do erro;
- `reason` e `terminatedBy`;
- timeout solicitado e efetivo;
- deadline e tempo decorrido;
- ID da requisição ou tarefa;
- estado e tamanhos dos logs persistidos.

Comandos acima de 300 segundos devem retornar uma tarefa persistente. Não aumente o timeout do Gateway, proxy ou cliente para manter uma chamada síncrona aberta.

## Validação após manutenção

```powershell
npm run check
npm run docker:production:status
```

Também execute diff-check, secret scan e os gates operacionais relacionados à alteração.
