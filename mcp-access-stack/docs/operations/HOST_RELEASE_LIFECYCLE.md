# Lifecycle de release dos hosts Windows

## Contrato atual

Cada release imutável contém o runner Node e a fonte do launcher nativo. As tarefas produtivas são instaladas com um `ReleaseRoot` explícito.

```text
Task Scheduler
  -> McpNodeHostLauncher.exe
    -> node.exe
      -> Run-DockerHostComponent.mjs --task-owned true
        -> Agent ou Browser Worker
```

Novas releases não incluem launchers PowerShell permanentes nem o modo antigo baseado em `launcher-lease.json`.

## Estado de release

- `releases/candidate.json`: artefato gerado e elegível para validação;
- `releases/active.json`: release implantada nos hosts;
- `manifest.json`: commit, versão do Node e hashes dos artefatos versionados.

A geração de uma release altera somente o ponteiro candidato. A ativação deve ocorrer apenas após os gates técnicos e operacionais.

## Geracao e distribuicao canonica

O build canonico ocorre no GitHub a partir de uma tag SemVer apontando para um commit validado. O PC de producao nao executa `npm ci`, `npm run build`, `docker build`, `docker save` ou `docker load`.

O workflow publico produz:

- `ghcr.io/<owner>/mcp-access-stack-gateway@sha256:<digest>`;
- `ghcr.io/<owner>/mcp-access-stack-proxy@sha256:<digest>`;
- um runtime Windows x64 minimo;
- `release-attestation.ps1` assinado, vinculando commit, `manifest.json` e digests GHCR;
- `distribution-manifest.ps1` assinado, vinculando todos os arquivos distribuidos;
- ZIP Windows + SHA-256 no GitHub Release.

Tags sao metadados humanos. O instalador e o updater consomem as imagens exclusivamente por digest.

## Instalação das tarefas

```powershell
pwsh -NoLogo -NoProfile -File deploy/docker/scripts/Install-McpHostTasks.ps1 `
  -Environment production `
  -ReleaseRoot <release-root>
```

Sem `-Activate`, as tarefas são registradas desabilitadas. O instalador exige release imutável válida, resolve uma versão compatível do Node e compila ou reutiliza o launcher nativo verificado por hash.

## Atualizacao candidate-first

1. O updater consulta um GitHub Release publico.
2. Valida SHA-256 do ZIP e Authenticode do manifesto de distribuicao.
3. Valida todos os hashes internos e a attestation assinada da release.
4. Executa `docker pull <repository>@<digest>` para Gateway e Proxy.
5. Valida o `RepoDigest` e a plataforma `linux/amd64`.
6. Materializa a release imutavel e atualiza somente `candidate.json`.
7. Se `-Promote` for solicitado, envia um pedido a Scheduled Task privilegiada.
8. A Scheduled Task revalida a attestation, executa o cutover e preserva rollback.

O updater nao depende de Git, branch local, `origin/main` ou working tree. A autoridade e a identidade criptografica da release: assinatura, hashes, commit e digests.

## Rollback

O rollback host deve restaurar os XMLs das tarefas e o ponteiro ativo previamente salvos. Releases anteriores necessárias ao rollback não devem ser removidas antes da validação final da nova release.

Após parar os hosts anteriores e antes de iniciar o candidato, a promoção captura o diretório persistente `registry` do Browser Worker. Em rollback, esse snapshot substitui integralmente o estado possivelmente migrado pelo candidato antes que o Browser Worker anterior seja iniciado.

O gate contra wrappers PowerShell considera somente processos PowerShell presentes na cadeia de ancestrais dos runners Agent e Browser Worker. Processos transitórios da própria promoção não são classificados como wrappers permanentes.

Execuções destacadas persistem um resultado terminal detalhado: `passed`, `rolled-back`, `rollback-failed`, `failed` ou `passed-after-controlled-recovery`. O runner externo só grava o fallback `failed` quando o lifecycle não produziu nenhum estado terminal.

Não existe mais rollback para o supervisor local antigo. A release de rollback preservada contém sua própria implementação e não depende da base atual.

## Gates mínimos

- `npm run check`;
- diff-check e secret scan;
- tarefas com executável igual ao launcher nativo verificado;
- `runner-lease.json` versão 2 saudável;
- Gateway ready;
- Browser Worker `live=200` e `ready=200`; estado `idle` e saudavel quando `connected=false`, pois o contexto e recriado sob demanda; falha de conexao/recovery continua retornando `ready=false`/HTTP 503;
- exatamente dois runners host produtivos;
- nenhum PowerShell permanente ou console visível;
- parada das tarefas sem processos órfãos;
- gate `candidate` aprovado em duas execuções independentes para beta;
- gate `stability` aprovado em três execuções independentes para release estável.

O gate `quick` é obrigatório durante alterações relevantes, mas não qualifica
uma publicação. Cada execução de `candidate` exige 20 minutos e 150 ações;
cada execução de `stability` exige 30 minutos e 300 ações. Tempo e volume são
simultâneos, todas as ações precisam passar e ambos exercitam reinícios
controlados. Não existe requisito de oito horas ou 1.000 ações. A evidência de
release só é gerada sobre uma árvore Git limpa e cada repetição possui relatório
próprio.

## Distribuicao publica Windows

Tags SemVer `v*` acionam `.github/workflows/release.yml`. O workflow e fail-closed e separa privilegios:

1. `signing-preflight` exige os segredos do certificado Code Signing antes de qualquer publicacao;
2. `metadata` resolve e valida tag, versao e commit;
3. `validate` executa `npm run check` em Windows;
4. `images` publica Gateway/Proxy no GHCR com SBOM, provenance e digests imutaveis;
5. `package` possui somente `contents:read`, monta o runtime, assina scripts/manifests e envia os assets por artifact efemero de 1 dia;
6. `publish` possui `contents:write`, mas nao recebe o certificado, e cria o GitHub Release.

Todas as Actions sao pinadas por SHA e checkout usa `persist-credentials:false`.

O instalador `deploy/windows/Install-McpAccessStack.ps1` exige `-Execute`, Windows x64, PowerShell 7, WSL2 e Docker Desktop. Node.js nao e pre-requisito do usuario: a release declara sua versao e o instalador baixa/verifica o runtime gerenciado. Chromium tambem e materializado pela revisao fixada na release.

O atualizador `deploy/windows/Update-McpAccessStack.ps1` consulta GitHub Releases, verifica SHA-256, Authenticode, manifesto, attestation e hashes internos. Sem `-Promote`, prepara apenas o candidato. Com `-Promote`, solicita o cutover a tarefa dedicada `McpAccessStack-Production-Promotion`; nao chama `Promote-McpProduction.ps1` diretamente.

A tarefa de promocao e os runners PowerShell de manutencao usam `ExecutionPolicy=AllSigned`. Assim, o Node instalado pode operar sem um checkout Git e sem toolchain de build.
