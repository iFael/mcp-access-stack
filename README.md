# MCP Access Stack

A GPT-only Model Context Protocol stack for controlled workspace, Git, shell, validation, and browser automation on Windows nodes.

The implementation lives in [`mcp-access-stack/`](mcp-access-stack/README.md).

## Distribution model

Production releases are built and validated on GitHub Actions. Gateway and Proxy are published to GHCR and consumed by immutable `sha256` digest. Windows nodes receive a small signed runtime package from GitHub Releases; they do not build Docker images or application source locally.

Machine-specific configuration, credentials, browser profiles, workspace policies, node identity, logs, and operational state are always local and excluded from Git.

## Development

```powershell
git clone <repository-url>
Set-Location mcp-access-stack/mcp-access-stack
npm ci
npm run check
```

## Security

Do not commit secrets, private URLs, credentials, local policies, profiles, or runtime state. Public releases fail closed when code-signing material is unavailable. See [Security Policy](.github/SECURITY.md) for vulnerability reporting.
