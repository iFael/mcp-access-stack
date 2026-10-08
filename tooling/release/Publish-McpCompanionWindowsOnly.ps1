[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]*$')][string]$CiRunId,
    [Parameter(Mandatory = $true)][string]$ArtifactsDirectory,
    [switch]$Publish
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$releaseId = "1.1.0-companion.$CiRunId"
$tag = "v$releaseId"
$name = "$tag-windows-x64.zip"
$outer = Join-Path $ArtifactsDirectory 'outer-actions-artifact.zip'
$assets = Join-Path $ArtifactsDirectory 'assets'
$expected = @($name, "$name.sha256")
Add-Type -AssemblyName System.IO.Compression

# Explicit ZIP allowlist prevents traversal or any unexpected Actions output.
$archive = [System.IO.Compression.ZipFile]::OpenRead($outer)
try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne 2 -or @($names | Select-Object -Unique).Count -ne 2 -or
        @($names | Where-Object { $expected -cnotcontains $_ }).Count -ne 0 -or
        @($archive.Entries | Where-Object { $_.Length -gt 300000000 }).Count -ne 0) {
        throw 'Actions archive must contain exactly the signed ZIP and SHA-256.'
    }
}
finally { $archive.Dispose() }
Expand-Archive -LiteralPath $outer -DestinationPath $assets
$zip = Join-Path $assets $name
$sum = Join-Path $assets "$name.sha256"
$manifestLine = (Get-Content -LiteralPath $sum -Raw).Trim()
if ($manifestLine -cnotmatch '^[a-f0-9]{64} \*v[0-9]+\.[0-9]+\.[0-9]+-companion\.[0-9]+-windows-x64\.zip$') {
    throw 'Signed distribution checksum manifest malformed.'
}
$checksum = $manifestLine -split ' '
if ($checksum[1] -cne ('*' + $name) -or
    (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $checksum[0]) {
    throw 'Signed companion inner ZIP checksum mismatch.'
}

# Offline Authenticode alone does not prove CI provenance; require signed GitHub attestation.
& gh attestation verify $zip --repo $env:GITHUB_REPOSITORY --signer-workflow "$($env:GITHUB_REPOSITORY)/.github/workflows/companion-only-distribution.yml" --source-ref 'refs/heads/main' --source-digest $ExpectedSourceSha
if ($LASTEXITCODE -ne 0) { throw 'GitHub artifact attestation verification failed.' }

$expanded = Join-Path $ArtifactsDirectory 'verified-distribution'
$inner = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $total = [long]0
    foreach ($entry in $inner.Entries) {
        $entryName = $entry.FullName.Replace('\', '/')
        if ($entryName.StartsWith('/') -or $entryName.Contains(':') -or
            $entryName -match '(^|/)\.\.(/|$)' -or $entry.Length -gt 500000000) {
            throw 'Signed distribution ZIP has an invalid entry.'
        }
        $total += $entry.Length
        if ($total -gt 1000000000) { throw 'Signed distribution exceeds extraction limit.' }
    }
}
finally { $inner.Dispose() }
Expand-Archive -LiteralPath $zip -DestinationPath $expanded
$common = Join-Path $expanded 'deploy/windows/PublicDistribution.Common.ps1'
if ((Get-AuthenticodeSignature -LiteralPath $common).Status -ne 'Valid') {
    throw 'Distribution verification script is not authenticode-valid.'
}
. $common
Assert-McpPublicDistribution -Root $expanded
$releaseRoot = Join-Path $expanded "releases/$releaseId"
& ./deploy/windows/Test-McpWindowsExecutionNodePackage.ps1 -ReleaseRoot $releaseRoot -OfflinePinnedAuthenticode
if ($LASTEXITCODE -ne 0) { throw 'Windows execution-node package verification failed.' }

if (-not $Publish) {
    Write-Output 'Verified, publication disabled.'
    return
}
$repo = $env:GITHUB_REPOSITORY
$main = (& gh api "repos/$repo/git/ref/heads/main" --jq '.object.sha').Trim()
if ($LASTEXITCODE -ne 0 -or $main -cne $ExpectedSourceSha) {
    throw 'Main CAS changed before release publication.'
}
# Fail closed on any existing tag or release; never replace previously published assets.
& gh api "repos/$repo/git/ref/tags/$tag" --silent 2>$null
if ($LASTEXITCODE -eq 0) { throw 'Tag already exists; reconcile the existing publication.' }
& gh release view $tag --repo $repo --json id 2>$null
if ($LASTEXITCODE -eq 0) { throw 'Release already exists; reconcile the existing publication.' }

& gh release create $tag $zip $sum --repo $repo --target $ExpectedSourceSha --prerelease --title "Signed Windows companion $tag" --notes "Windows-only signed bootstrap for $ExpectedSourceSha. Does not deploy Edge."
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub Release outcome unknown; inspect the same tag and assets before retry.'
}
Write-Output 'Signed Windows-only GitHub Release published; no installer or Edge deployment invoked.'
