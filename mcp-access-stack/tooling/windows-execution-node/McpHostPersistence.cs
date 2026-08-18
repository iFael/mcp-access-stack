using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

internal sealed class PersistentHostOptions
{
    public string InstallationRoot = string.Empty;
    public string ProjectRoot = string.Empty;
    public string EnvironmentName = string.Empty;
    public string CredentialBrokerPath = string.Empty;
    public string HealthStatePath = string.Empty;
    public int RestartCount;
    public int RestartIntervalSeconds;
    public int ReadinessTimeoutSeconds;
}

internal static class ExecutionNodePersistence
{
    private const string LifecycleStateFileName = "lifecycle-state.v1.json";
    public static int Run(PersistentHostOptions options, string contractVersion)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT)
        {
            throw new PlatformNotSupportedException("McpHost persistent ownership requires Windows.");
        }

        string installationRoot = Path.GetFullPath(options.InstallationRoot);
        string projectRoot = Path.GetFullPath(options.ProjectRoot);
        if (!Directory.Exists(installationRoot))
        {
            throw new DirectoryNotFoundException("Execution-node installation root was not found: " + installationRoot);
        }
        if (!Directory.Exists(projectRoot))
        {
            throw new DirectoryNotFoundException("Execution-node project root was not found: " + projectRoot);
        }
        RejectReparsePoint(installationRoot, "installation root");
        RejectReparsePoint(projectRoot, "project root");
        RejectOverlappingRoots(installationRoot, projectRoot);

        string stateRoot = Path.Combine(installationRoot, "state");
        string releasesRoot = Path.Combine(installationRoot, "releases");
        string stableHostRoot = Path.Combine(installationRoot, "host");
        RequireDirectory(stateRoot, "state root");
        RequireDirectory(releasesRoot, "releases root");
        RequireDirectory(stableHostRoot, "stable host root");
        RejectReparsePoint(stateRoot, "state root");
        RejectReparsePoint(releasesRoot, "releases root");
        RejectReparsePoint(stableHostRoot, "stable host root");

        string stableHostPath = Path.Combine(stableHostRoot, "McpHost.exe");
        string currentExecutablePath = GetCurrentExecutablePath();
        if (!string.Equals(
            Path.GetFullPath(currentExecutablePath),
            Path.GetFullPath(stableHostPath),
            StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "McpHost --run-active must execute from the stable installation host path.");
        }

        string ownershipLockPath = Path.Combine(
            stateRoot,
            "host-ownership-" + options.EnvironmentName + ".lock");
        using (FileStream ownership = AcquireOwnershipLock(ownershipLockPath))
        {
            PersistentActiveState active = ReadActiveState(Path.Combine(stateRoot, LifecycleStateFileName));
            string releaseRoot = ResolveChildDirectory(releasesRoot, active.ReleaseId);
            ReleaseContractInfo release = ReleaseContract.Validate(
                releaseRoot,
                active.ManifestSha256);

            if (!string.Equals(release.ReleaseId, active.ReleaseId, StringComparison.Ordinal))
            {
                throw new InvalidDataException("Persistent host active pointer identity mismatch.");
            }
            if (string.IsNullOrWhiteSpace(release.HostPath))
            {
                throw new InvalidDataException("Persistent host release did not expose its McpHost artifact.");
            }

            string stableHash = Hashing.Sha256File(stableHostPath);
            string releaseHostHash = Hashing.Sha256File(release.HostPath);
            if (!string.Equals(stableHash, releaseHostHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "Stable McpHost does not match the active release McpHost artifact.");
            }

            WriteOwnershipEvidence(
                ownership,
                active.ReleaseId,
                active.ManifestSha256,
                options.EnvironmentName);

            SupervisorOptions supervisor = new SupervisorOptions();
            supervisor.ReleaseRoot = releaseRoot;
            supervisor.ProjectRoot = projectRoot;
            supervisor.EnvironmentName = options.EnvironmentName;
            supervisor.ExpectedManifestSha256 = active.ManifestSha256;
            supervisor.CredentialBrokerPath = options.CredentialBrokerPath;
            supervisor.HealthStatePath = options.HealthStatePath;
            supervisor.RestartCount = options.RestartCount;
            supervisor.RestartIntervalSeconds = options.RestartIntervalSeconds;
            supervisor.ReadinessTimeoutSeconds = options.ReadinessTimeoutSeconds;
            supervisor.QualificationOwnerPid = 0;

            return ExecutionNodeSupervisor.Run(supervisor, contractVersion);
        }
    }

    private static FileStream AcquireOwnershipLock(string path)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None);
        }
        catch (IOException)
        {
            throw new InvalidOperationException(
                "Another persistent McpHost already owns this execution-node environment.");
        }
    }

    private static PersistentActiveState ReadActiveState(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("Execution-node state file was not found.", path);
        }
        RejectReparsePoint(path, "state file");
        Dictionary<string, object> state = JsonData.ReadObject(path);
        if (JsonData.RequireInteger(state, "version") != 1)
        {
            throw new InvalidDataException("Unsupported execution-node state version.");
        }

        object activeValue;
        if (!state.TryGetValue("active", out activeValue) || activeValue == null)
        {
            throw new InvalidDataException("Persistent McpHost requires an active execution-node release.");
        }
        Dictionary<string, object> active = JsonData.RequireObject(activeValue, "active");
        string releaseId = JsonData.RequireString(active, "releaseId");
        string manifestSha256 = JsonData.RequireString(active, "manifestSha256").ToLowerInvariant();
        string materializedAt = JsonData.RequireString(active, "materializedAt");
        if (!IsSafeReleaseId(releaseId) || !Hashing.IsSha256(manifestSha256))
        {
            throw new InvalidDataException("Persistent McpHost active pointer is invalid.");
        }
        DateTimeOffset parsed;
        if (!DateTimeOffset.TryParse(materializedAt, out parsed))
        {
            throw new InvalidDataException("Persistent McpHost active pointer timestamp is invalid.");
        }

        PersistentActiveState result = new PersistentActiveState();
        result.ReleaseId = releaseId;
        result.ManifestSha256 = manifestSha256;
        return result;
    }

    private static string ResolveChildDirectory(string root, string relativeName)
    {
        string resolvedRoot = Path.GetFullPath(root).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        string child = Path.GetFullPath(Path.Combine(resolvedRoot, relativeName));
        string prefix = resolvedRoot + Path.DirectorySeparatorChar;
        if (!child.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Execution-node release path escaped the releases root.");
        }
        RequireDirectory(child, "active release root");
        RejectReparsePoint(child, "active release root");
        return child;
    }

    private static void RequireDirectory(string path, string label)
    {
        if (!Directory.Exists(path))
        {
            throw new DirectoryNotFoundException("Execution-node " + label + " was not found: " + path);
        }
    }

    private static void RejectOverlappingRoots(string first, string second)
    {
        string firstRoot = first.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string secondRoot = second.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (ContainsPath(firstRoot, secondRoot) || ContainsPath(secondRoot, firstRoot))
        {
            throw new InvalidDataException(
                "Execution-node installation root and project root must not overlap.");
        }
    }

    private static bool ContainsPath(string parent, string child)
    {
        if (string.Equals(parent, child, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        string prefix = parent + Path.DirectorySeparatorChar;
        return child.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static void RejectReparsePoint(string path, string label)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("Execution-node " + label + " must not be a reparse point.");
        }
    }

    private static string GetCurrentExecutablePath()
    {
        using (Process current = Process.GetCurrentProcess())
        {
            if (current.MainModule == null || string.IsNullOrWhiteSpace(current.MainModule.FileName))
            {
                throw new InvalidOperationException("Unable to resolve the current McpHost executable path.");
            }
            return current.MainModule.FileName;
        }
    }

    private static void WriteOwnershipEvidence(
        FileStream stream,
        string releaseId,
        string manifestSha256,
        string environmentName)
    {
        string payload =
            "pid=" + Process.GetCurrentProcess().Id.ToString() + Environment.NewLine +
            "environment=" + environmentName + Environment.NewLine +
            "releaseId=" + releaseId + Environment.NewLine +
            "manifestSha256=" + manifestSha256 + Environment.NewLine +
            "acquiredAt=" + DateTimeOffset.UtcNow.ToString("O") + Environment.NewLine;
        byte[] bytes = new UTF8Encoding(false).GetBytes(payload);
        stream.SetLength(0);
        stream.Position = 0;
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
    }

    private static bool IsSafeReleaseId(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool safe = char.IsLetterOrDigit(character) || character == '.' || character == '_' || character == '-';
            if (!safe || (index == 0 && !char.IsLetterOrDigit(character)))
            {
                return false;
            }
        }
        return true;
    }

    private sealed class PersistentActiveState
    {
        public string ReleaseId = string.Empty;
        public string ManifestSha256 = string.Empty;
    }
}
