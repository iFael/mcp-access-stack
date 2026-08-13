# Arquitetura GPT-only

## Fluxo de produção

```text
ChatGPT
  -> túnel HTTPS (container)
  -> proxy MCP :3300 (container)
  -> gateway :3310 (container)
     |-> Workspace Agent (Windows)
     `-> Browser Worker :3350 (Windows)
```

Gateway, Proxy e Tunnel executam em Docker. Workspace Agent e Browser Worker permanecem no Windows porque dependem de filesystem, Git, shells autorizados e da sessão interativa do Chrome.

## Hosts Windows

```text
Task Scheduler
  -> McpNodeHostLauncher.exe
    -> node.exe
      -> Run-DockerHostComponent.mjs --task-owned true
        -> Workspace Agent ou Browser Worker
```

O launcher nativo usa o subsistema Windows GUI, não abre console e mantém a árvore de processos em um Job Object. O runner Node mantém `runner-lease.json`, reinicia falhas transitórias e encerra o filho quando a tarefa é parada.

PowerShell é permitido somente para instalação, atualização, diagnóstico e manutenção one-shot. Ele não participa da árvore permanente dos hosts.

## Responsabilidades

- Proxy: publica somente a rota MCP configurada.
- Gateway: autenticação, ferramentas MCP, Actions e relay.
- Workspace Agent: políticas, arquivos, Git, shell, validações e auditoria.
- Browser Worker: automação de abas MCP-owned em perfil dedicado.
- Tunnel: endpoint HTTPS público configurado fora do Git.

## Portas

- `3300`: proxy MCP;
- `3310`: gateway;
- `3350`: Browser Worker.

As portas `3320`, `3330` e `3340` não fazem parte da produção atual.
