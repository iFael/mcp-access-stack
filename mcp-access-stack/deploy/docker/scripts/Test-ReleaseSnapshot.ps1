[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-release-snapshot-test-' + [guid]::NewGuid().ToString('N'))
$repositoryRoot = Join-Path $tempRoot 'repository'
$projectRoot = Join-Path $repositoryRoot 'nested-project'
$snapshotDirectory = Join-Path $tempRoot 'snapshot'
$hostReleaseRoot = Join-Path $tempRoot 'host-release'

try {
    New-Item -ItemType Directory -Force -Path $projectRoot | Out-Null
    & git -C $repositoryRoot init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize snapshot test repository.' }
    & git -C $repositoryRoot config user.name 'MCP Snapshot Test'
    & git -C $repositoryRoot config user.email 'snapshot-test@example.invalid'

    $trackedPath = Join-Path $projectRoot 'tracked.txt'
    $untrackedPath = Join-Path $projectRoot 'untracked.txt'
    $repositoryContextPath = Join-Path $repositoryRoot '.github\workflows\release.yml'
    $repositoryUntrackedPath = Join-Path $repositoryRoot '.github\workflows\untracked.yml'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $repositoryContextPath) | Out-Null
    [System.IO.File]::WriteAllText($trackedPath, "committed`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($repositoryContextPath, "name: committed-release`n", [System.Text.UTF8Encoding]::new($false))
    & git -C $repositoryRoot add -- 'nested-project/tracked.txt' '.github/workflows/release.yml'
    & git -C $repositoryRoot commit --quiet -m 'snapshot fixture'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to commit snapshot fixture.' }

    $commit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    [System.IO.File]::WriteAllText($trackedPath, "dirty`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($untrackedPath, "untracked`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($repositoryContextPath, "name: dirty-release`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($repositoryUntrackedPath, "name: untracked-release`n", [System.Text.UTF8Encoding]::new($false))

    $snapshotRoot = Export-McpGitSnapshot -Root $projectRoot -Commit $commit -Destination $snapshotDirectory
    $snapshotTrackedPath = Join-Path $snapshotRoot 'tracked.txt'
    $snapshotUntrackedPath = Join-Path $snapshotRoot 'untracked.txt'
    $snapshotRepositoryRoot = Split-Path -Parent $snapshotRoot
    $snapshotRepositoryContextPath = Join-Path $snapshotRepositoryRoot '.github\workflows\release.yml'
    $snapshotRepositoryUntrackedPath = Join-Path $snapshotRepositoryRoot '.github\workflows\untracked.yml'

    if (-not (Test-Path -LiteralPath $snapshotTrackedPath -PathType Leaf)) {
        throw 'Committed file was not exported to the snapshot.'
    }
    $snapshotContent = (Get-Content -Raw -LiteralPath $snapshotTrackedPath).Replace("`r`n", "`n")
    if ($snapshotContent -ne "committed`n") {
        throw 'Snapshot included working-tree changes instead of the committed content.'
    }
    if (Test-Path -LiteralPath $snapshotUntrackedPath) {
        throw 'Snapshot included an untracked project file.'
    }
    if (-not (Test-Path -LiteralPath $snapshotRepositoryContextPath -PathType Leaf)) {
        throw 'Snapshot omitted committed repository-level context.'
    }
    $snapshotRepositoryContext = (Get-Content -Raw -LiteralPath $snapshotRepositoryContextPath).Replace("`r`n", "`n")
    if ($snapshotRepositoryContext -ne "name: committed-release`n") {
        throw 'Snapshot included dirty repository-level context instead of committed content.'
    }
    if (Test-Path -LiteralPath $snapshotRepositoryUntrackedPath) {
        throw 'Snapshot included an untracked repository-level file.'
    }

    $actualProjectRoot = Get-McpProjectRoot
    Copy-McpReleaseHostScripts -SourceRoot $actualProjectRoot -DestinationRoot $hostReleaseRoot
    $runnerPath = Get-McpReleaseHostRunnerPath -ReleaseRoot $hostReleaseRoot
    $launcherSourcePath = Get-McpReleaseNodeHostLauncherSourcePath -ReleaseRoot $hostReleaseRoot
    $brokerSourcePath = Get-McpReleaseCredentialBrokerSourcePath -ReleaseRoot $hostReleaseRoot
    $expectedRunnerPath = [System.IO.Path]::GetFullPath(
        (Join-Path $hostReleaseRoot 'deploy\docker\scripts\Run-DockerHostComponent.mjs')
    )
    $expectedLauncherSourcePath = [System.IO.Path]::GetFullPath(
        (Join-Path $hostReleaseRoot 'tooling\windows-host-launcher\McpNodeHostLauncher.cs')
    )
    $expectedBrokerSourcePath = [System.IO.Path]::GetFullPath(
        (Join-Path $hostReleaseRoot 'tooling\windows-credential-broker\McpCredentialBroker.cs')
    )
    if ($runnerPath -ne $expectedRunnerPath) {
        throw "Unexpected immutable runner path: $runnerPath"
    }
    if ($launcherSourcePath -ne $expectedLauncherSourcePath) {
        throw "Unexpected immutable native launcher source path: $launcherSourcePath"
    }
    if ($brokerSourcePath -ne $expectedBrokerSourcePath) {
        throw "Unexpected immutable credential broker source path: $brokerSourcePath"
    }

    foreach ($scriptName in Get-McpReleaseHostScriptNames) {
        $copiedPath = Join-Path $hostReleaseRoot "deploy\docker\scripts\$scriptName"
        if (-not (Test-Path -LiteralPath $copiedPath -PathType Leaf)) {
            throw "Host runtime script was not copied into the release: $scriptName"
        }
    }

    $portableRoot = Join-Path $tempRoot 'portable-workspaces'
    $portableWorkspace = Join-Path $portableRoot 'services\example-service'
    $portableDist = Join-Path $portableWorkspace 'dist'
    $portableScope = Join-Path $portableRoot 'node_modules\@example'
    New-Item -ItemType Directory -Force -Path $portableDist, $portableScope | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $portableWorkspace 'package.json'),
        '{"name":"@example/example-service","version":"1.0.0","type":"module","main":"./dist/index.js"}',
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $portableDist 'index.js'),
        "export const portable = true;`n",
        [Text.UTF8Encoding]::new($false)
    )
    $junctionPath = Join-Path $portableScope 'example-service'
    New-Item -ItemType Junction -Path $junctionPath -Target $portableWorkspace | Out-Null
    if ([string]::IsNullOrWhiteSpace([string](Get-Item -LiteralPath $junctionPath -Force).LinkType)) {
        throw 'Workspace portability fixture did not create a filesystem link.'
    }

    Convert-McpReleaseWorkspaceModulesToDirectories `
        -ReleaseRoot $portableRoot `
        -WorkspacePaths @('services\example-service')
    $materializedModule = Get-Item -LiteralPath $junctionPath -Force
    if (-not [string]::IsNullOrWhiteSpace([string]$materializedModule.LinkType)) {
        throw 'Workspace module was not materialized as a physical directory.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $junctionPath 'dist\index.js') -PathType Leaf)) {
        throw 'Materialized workspace module lost its runtime dist content.'
    }

    $movedPortableRoot = Join-Path $tempRoot 'portable-workspaces-moved'
    Move-Item -LiteralPath $portableRoot -Destination $movedPortableRoot
    $movedModule = Join-Path $movedPortableRoot 'node_modules\@example\example-service'
    if (
        -not (Test-Path -LiteralPath (Join-Path $movedModule 'dist\index.js') -PathType Leaf) -or
        -not [string]::IsNullOrWhiteSpace([string](Get-Item -LiteralPath $movedModule -Force).LinkType)
    ) {
        throw 'Materialized workspace module is not portable after the release tree is moved.'
    }

    $runnerContent = Get-Content -Raw -LiteralPath $runnerPath
    if ($runnerContent -notmatch 'requiredArgument\(argumentsMap, "project-root"\)') {
        throw 'Immutable host runner does not require an explicit project-root binding.'
    }

    $brokerSourceContent = Get-Content -Raw -LiteralPath $brokerSourcePath
    if (
        $brokerSourceContent -notmatch 'NamedPipeServerStream' -or
        $brokerSourceContent -notmatch 'GetNamedPipeClientProcessId' -or
        $brokerSourceContent -notmatch 'CredReadW' -or
        $brokerSourceContent -notmatch 'UseSystemPasswordChar = true'
    ) {
        throw 'Credential broker source does not preserve IPC, process identity and secure UI requirements.'
    }

    $launcherSourceContent = Get-Content -Raw -LiteralPath $launcherSourcePath
    if (
        $launcherSourceContent -notmatch 'CreateNoWindow = true' -or
        $launcherSourceContent -notmatch 'AssignProcessToJobObject' -or
        $launcherSourceContent -notmatch 'JobObjectLimitKillOnJobClose' -or
        $launcherSourceContent -notmatch 'native_launcher_child_restart_scheduled' -or
        $launcherSourceContent -notmatch 'RunnerRestartIntervalSeconds = 60'
    ) {
        throw 'Native launcher source does not preserve no-window and process-tree ownership semantics.'
    }

    if (
        $runnerContent -notmatch 'requiredArgument\(argumentsMap, "task-owned"\)' -or
        $runnerContent -notmatch 'BROWSER_WORKER_CREDENTIAL_BROKER_PATH' -or
        $runnerContent -notmatch 'Host runner requires --task-owned true' -or
        $runnerContent -notmatch 'host_runner_lease_write_failed' -or
        $runnerContent -notmatch 'LEASE_WRITE_RETRY_COUNT' -or
        $runnerContent -match 'launcher-pid|launcher-lease|runLauncherOwned'
    ) {
        throw 'Immutable host runner is not restricted to scheduled-task ownership.'
    }

    $installerContent = Get-Content -Raw -LiteralPath (Join-Path $actualProjectRoot 'deploy\docker\scripts\Install-McpHostTasks.ps1')
    if (
        $installerContent -notmatch 'Get-McpReleaseHostRunnerPath' -or
        $installerContent -notmatch "'--project-root'" -or
        $installerContent -notmatch 'Get-McpNodeExecutable' -or
        $installerContent -notmatch "'--task-owned'" -or
        $installerContent -notmatch "'--runner-restart-count'" -or
        $installerContent -notmatch "'--runner-restart-interval-seconds'" -or
        $installerContent -notmatch "'--restart-count'" -or
        $installerContent -notmatch "'--restart-interval-seconds'"
    ) {
        throw 'Host task installer is not pinned directly to the immutable task-owned Node runner and operational root.'
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'Release snapshot test passed: committed content, native launcher source and task-owned Node runner are isolated.'
