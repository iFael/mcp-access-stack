using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Program
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const string ContractVersion = "mcp-edge-host-contract-v1";
    private static readonly object LogGate = new object();

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class Options
    {
        public string ReleaseRoot = string.Empty;
        public string ExpectedManifestSha256 = string.Empty;
        public string RuntimeRoot = string.Empty;
        public string EdgeBaseUrl = string.Empty;
        public string ConnectorTokenFile = string.Empty;
        public string OwnerTokenFile = string.Empty;
        public string PolicyPath = string.Empty;
        public string AllowedOrigins = string.Empty;
        public string OwnerOAuthScopes = string.Empty;
        public int MaxConcurrentRequests;
        public int RestartCount;
        public int RestartIntervalSeconds;
        public bool BrowserEnabled;
        public string BrowserWorkerUrl = string.Empty;
        public string BrowserWorkerTokenFile = string.Empty;
        public bool ValidateOnly;
    }

    private sealed class ReleaseInfo
    {
        public string Root = string.Empty;
        public string ManifestSha256 = string.Empty;
        public string NodePath = string.Empty;
        public string EdgeCliPath = string.Empty;
        public string EdgeHostPath = string.Empty;
        public string ValidationLauncherPath = string.Empty;
    }

    private static int Main(string[] args)
    {
        Options options = null;
        IntPtr job = IntPtr.Zero;
        string ownerToken = null;
        string browserToken = null;

        try
        {
            if (args.Length == 1 && string.Equals(args[0], "--version", StringComparison.Ordinal))
            {
                Console.WriteLine(ContractVersion);
                return 0;
            }

            options = ParseArguments(args);
            ValidateOptions(options);
            ReleaseInfo release = ValidateRelease(options.ReleaseRoot, options.ExpectedManifestSha256);
            ValidateSelf(release.EdgeHostPath);

            string connectorTokenPath = ValidateSecretFile(options.ConnectorTokenFile, "Connector token", 16, 2048);
            string ownerTokenPath = ValidateSecretFile(options.OwnerTokenFile, "Owner token", 16, 2048);
            string policyPath = RequireFile(options.PolicyPath, "Workspace policy");
            ownerToken = ReadSecretValue(ownerTokenPath, "Owner token", 16, 2048);

            Uri edgeUri = ValidateEdgeOrigin(options.EdgeBaseUrl);
            Uri browserUri = null;
            string browserTokenPath = string.Empty;
            if (options.BrowserEnabled)
            {
                browserUri = ValidateBrowserOrigin(options.BrowserWorkerUrl);
                browserTokenPath = ValidateSecretFile(options.BrowserWorkerTokenFile, "Browser Worker token", 32, 2048);
                browserToken = ReadSecretValue(browserTokenPath, "Browser Worker token", 32, 2048);
            }

            string logs = Path.Combine(options.RuntimeRoot, "logs");
            Directory.CreateDirectory(logs);
            string stdoutLog = Path.Combine(logs, "edge-connector.stdout.log");
            string stderrLog = Path.Combine(logs, "edge-connector.stderr.log");

            if (options.ValidateOnly)
            {
                Console.WriteLine(ContractVersion);
                return 0;
            }

            AppendEvent(stderrLog, "edge_host_starting", "restartCount=" + options.RestartCount.ToString());
            job = CreateKillOnCloseJob();

            int restartAttempt = 0;
            while (true)
            {
                int exitCode;
                try
                {
                    exitCode = RunNodeChild(
                        release,
                        options,
                        edgeUri,
                        browserUri,
                        connectorTokenPath,
                        ownerToken,
                        browserToken,
                        policyPath,
                        stdoutLog,
                        stderrLog,
                        job,
                        restartAttempt);
                }
                catch (Exception error)
                {
                    AppendEvent(
                        stderrLog,
                        "edge_host_child_failed",
                        error.GetType().Name + ": " + Sanitize(error.Message) +
                        " restartAttempt=" + restartAttempt.ToString());
                    exitCode = 1;
                }

                if (exitCode == 0)
                {
                    return 0;
                }
                if (restartAttempt >= options.RestartCount)
                {
                    AppendEvent(
                        stderrLog,
                        "edge_host_restart_exhausted",
                        "exitCode=" + exitCode.ToString() +
                        " restartAttempt=" + restartAttempt.ToString());
                    return NormalizeExitCode(exitCode);
                }

                restartAttempt++;
                AppendEvent(
                    stderrLog,
                    "edge_host_child_restart_scheduled",
                    "exitCode=" + exitCode.ToString() +
                    " restartAttempt=" + restartAttempt.ToString() +
                    " delaySeconds=" + options.RestartIntervalSeconds.ToString());
                Thread.Sleep(TimeSpan.FromSeconds(options.RestartIntervalSeconds));
            }
        }
        catch (Exception error)
        {
            string stderrLog = TryGetErrorLogPath(options);
            AppendEvent(stderrLog, "edge_host_failed", error.GetType().Name + ": " + Sanitize(error.Message));
            Console.Error.WriteLine(error.GetType().Name + ": " + Sanitize(error.Message));
            return 1;
        }
        finally
        {
            ownerToken = null;
            browserToken = null;
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
        }
    }

    private static Options ParseArguments(string[] args)
    {
        Options options = new Options();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        int index = 0;
        while (index < args.Length)
        {
            string name = args[index];
            if (string.Equals(name, "--validate-only", StringComparison.Ordinal))
            {
                if (!seen.Add(name))
                {
                    throw new ArgumentException("Duplicate McpEdgeHost option: " + name);
                }
                options.ValidateOnly = true;
                index++;
                continue;
            }
            if (!IsAllowedOption(name))
            {
                throw new ArgumentException("Unsupported McpEdgeHost option: " + name);
            }
            if (!seen.Add(name))
            {
                throw new ArgumentException("Duplicate McpEdgeHost option: " + name);
            }
            if (index + 1 >= args.Length)
            {
                throw new ArgumentException("Missing value for McpEdgeHost option: " + name);
            }
            string value = args[index + 1];
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException("McpEdgeHost option value must not be empty: " + name);
            }

            if (name == "--release-root") options.ReleaseRoot = value;
            else if (name == "--expected-manifest-sha256") options.ExpectedManifestSha256 = value;
            else if (name == "--runtime-root") options.RuntimeRoot = value;
            else if (name == "--edge-base-url") options.EdgeBaseUrl = value;
            else if (name == "--connector-token-file") options.ConnectorTokenFile = value;
            else if (name == "--owner-token-file") options.OwnerTokenFile = value;
            else if (name == "--policy-path") options.PolicyPath = value;
            else if (name == "--allowed-origins") options.AllowedOrigins = value;
            else if (name == "--owner-oauth-scopes") options.OwnerOAuthScopes = value;
            else if (name == "--max-concurrent-requests") options.MaxConcurrentRequests = ParseInteger(name, value, 1, 64);
            else if (name == "--restart-count") options.RestartCount = ParseInteger(name, value, 0, 100);
            else if (name == "--restart-interval-seconds") options.RestartIntervalSeconds = ParseInteger(name, value, 1, 3600);
            else if (name == "--browser-enabled") options.BrowserEnabled = ParseBoolean(name, value);
            else if (name == "--browser-worker-url") options.BrowserWorkerUrl = value;
            else if (name == "--browser-worker-token-file") options.BrowserWorkerTokenFile = value;
            index += 2;
        }
        return options;
    }

    private static bool IsAllowedOption(string value)
    {
        return value == "--release-root" ||
            value == "--expected-manifest-sha256" ||
            value == "--runtime-root" ||
            value == "--edge-base-url" ||
            value == "--connector-token-file" ||
            value == "--owner-token-file" ||
            value == "--policy-path" ||
            value == "--allowed-origins" ||
            value == "--owner-oauth-scopes" ||
            value == "--max-concurrent-requests" ||
            value == "--restart-count" ||
            value == "--restart-interval-seconds" ||
            value == "--browser-enabled" ||
            value == "--browser-worker-url" ||
            value == "--browser-worker-token-file";
    }

    private static void ValidateOptions(Options options)
    {
        options.ReleaseRoot = RequireDirectory(options.ReleaseRoot, "Release root");
        options.RuntimeRoot = RequireDirectory(options.RuntimeRoot, "Runtime root");
        options.ConnectorTokenFile = RequireAbsolutePath(options.ConnectorTokenFile, "Connector token file");
        options.OwnerTokenFile = RequireAbsolutePath(options.OwnerTokenFile, "Owner token file");
        options.PolicyPath = RequireAbsolutePath(options.PolicyPath, "Workspace policy path");

        if (!IsSha256(options.ExpectedManifestSha256))
        {
            throw new ArgumentException("Expected execution manifest SHA-256 is invalid.");
        }
        if (string.IsNullOrWhiteSpace(options.EdgeBaseUrl))
        {
            throw new ArgumentException("Edge base URL is required.");
        }
        if (!IsBoundedText(options.AllowedOrigins, 4096))
        {
            throw new ArgumentException("Allowed origins value is invalid.");
        }
        if (!IsBoundedText(options.OwnerOAuthScopes, 2048))
        {
            throw new ArgumentException("Owner OAuth scopes value is invalid.");
        }
        if (options.MaxConcurrentRequests < 1)
        {
            throw new ArgumentException("Max concurrent requests is required.");
        }
        if (options.RestartIntervalSeconds < 1)
        {
            throw new ArgumentException("Restart interval is required.");
        }
        if (options.BrowserEnabled)
        {
            options.BrowserWorkerTokenFile = RequireAbsolutePath(options.BrowserWorkerTokenFile, "Browser Worker token file");
            if (string.IsNullOrWhiteSpace(options.BrowserWorkerUrl))
            {
                throw new ArgumentException("Browser Worker URL is required when browser integration is enabled.");
            }
        }
    }

    private static ReleaseInfo ValidateRelease(string releaseRoot, string expectedManifestSha256)
    {
        string root = Path.GetFullPath(releaseRoot);
        RejectReparsePoint(root, "release root");
        string releaseManifestPath = ResolveReleaseFile(root, "manifest.json");
        string executionManifestPath = ResolveReleaseFile(root, "execution-node-manifest.json");
        string actualManifestHash = Sha256File(executionManifestPath);
        if (!string.Equals(actualManifestHash, expectedManifestSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Execution-node manifest hash mismatch.");
        }

        Dictionary<string, object> releaseManifest = ReadJsonObject(releaseManifestPath);
        Dictionary<string, object> executionManifest = ReadJsonObject(executionManifestPath);
        string releaseId = RequireJsonString(releaseManifest, "releaseId");
        string commit = RequireJsonString(releaseManifest, "commit");
        if (!IsSafeReleaseId(releaseId) || !IsCommit(commit))
        {
            throw new InvalidDataException("Release manifest identity is invalid.");
        }
        if (RequireJsonInteger(executionManifest, "version") != 1 ||
            !string.Equals(RequireJsonString(executionManifest, "releaseId"), releaseId, StringComparison.Ordinal) ||
            !string.Equals(RequireJsonString(executionManifest, "commit"), commit, StringComparison.Ordinal) ||
            !string.Equals(RequireJsonString(executionManifest, "platform"), "win32-x64", StringComparison.Ordinal) ||
            !string.Equals(RequireJsonString(executionManifest, "runtimeMode"), "bundled-node", StringComparison.Ordinal) ||
            !string.Equals(RequireJsonString(executionManifest, "integrityRoot"), "signed-distribution-manifest", StringComparison.Ordinal))
        {
            throw new InvalidDataException("Execution-node manifest identity is invalid.");
        }

        IList artifacts = RequireJsonList(executionManifest, "artifacts");
        string nodePath = ValidateArtifact(artifacts, root, "node-runtime", "runtime/node/node.exe", false);
        string edgeCliPath = ValidateArtifact(
            artifacts,
            root,
            "edge-connector",
            "node_modules/@vs-code-gpt/remote-mcp-gateway/dist/edge-connector-cli.js",
            false);
        string validationLauncherPath = ValidateArtifact(
            artifacts,
            root,
            "edge-connector-launcher",
            "deploy/windows/Start-McpEdgeConnector.ps1",
            true);
        string edgeHostPath = ValidateArtifact(
            artifacts,
            root,
            "edge-host",
            "native/McpEdgeHost.exe",
            true);

        ReleaseInfo result = new ReleaseInfo();
        result.Root = root;
        result.ManifestSha256 = actualManifestHash;
        result.NodePath = nodePath;
        result.EdgeCliPath = edgeCliPath;
        result.EdgeHostPath = edgeHostPath;
        result.ValidationLauncherPath = validationLauncherPath;
        return result;
    }

    private static string ValidateArtifact(
        IList artifacts,
        string root,
        string role,
        string expectedRelativePath,
        bool authenticodeRequired)
    {
        Dictionary<string, object> match = null;
        int count = 0;
        foreach (object item in artifacts)
        {
            Dictionary<string, object> artifact = item as Dictionary<string, object>;
            if (artifact == null)
            {
                throw new InvalidDataException("Execution-node artifact must be an object.");
            }
            string currentRole = RequireJsonString(artifact, "role");
            if (string.Equals(currentRole, role, StringComparison.Ordinal))
            {
                match = artifact;
                count++;
            }
        }
        if (count != 1 || match == null)
        {
            throw new InvalidDataException("Execution-node artifact role is missing or duplicated: " + role);
        }

        string relativePath = RequireJsonString(match, "path").Replace('\\', '/');
        if (!string.Equals(relativePath, expectedRelativePath, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Execution-node artifact path is invalid: " + role);
        }
        string artifactPath = ResolveReleaseFile(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        long expectedSize = RequireJsonLong(match, "sizeBytes");
        string expectedHash = RequireJsonString(match, "sha256").ToLowerInvariant();
        if (expectedSize < 0 || !IsSha256(expectedHash))
        {
            throw new InvalidDataException("Execution-node artifact integrity metadata is invalid: " + role);
        }
        FileInfo info = new FileInfo(artifactPath);
        if (info.Length != expectedSize)
        {
            throw new InvalidDataException("Execution-node artifact size mismatch: " + role);
        }
        if (!string.Equals(Sha256File(artifactPath), expectedHash, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Execution-node artifact hash mismatch: " + role);
        }
        if (authenticodeRequired && !OptionalJsonBoolean(match, "authenticodeRequired", false))
        {
            throw new InvalidDataException("Execution-node native Edge artifact must require Authenticode: " + role);
        }
        return artifactPath;
    }

    private static void ValidateSelf(string expectedHostPath)
    {
        string actual = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
        if (!string.Equals(actual, Path.GetFullPath(expectedHostPath), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("McpEdgeHost must execute from the immutable release artifact.");
        }
    }

    private static int RunNodeChild(
        ReleaseInfo release,
        Options options,
        Uri edgeUri,
        Uri browserUri,
        string connectorTokenPath,
        string ownerToken,
        string browserToken,
        string policyPath,
        string stdoutLog,
        string stderrLog,
        IntPtr job,
        int restartAttempt)
    {
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = release.NodePath;
        startInfo.Arguments = QuoteWindowsArgument(release.EdgeCliPath);
        startInfo.WorkingDirectory = Path.GetDirectoryName(release.EdgeCliPath);
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.RedirectStandardInput = false;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;

        startInfo.EnvironmentVariables["MCP_EDGE_BASE_URL"] = edgeUri.GetLeftPart(UriPartial.Authority);
        startInfo.EnvironmentVariables["MCP_CONNECTOR_TOKEN_FILE"] = connectorTokenPath;
        startInfo.EnvironmentVariables["VS_CODE_GPT_POLICY_PATH"] = policyPath;
        startInfo.EnvironmentVariables["MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS"] = options.MaxConcurrentRequests.ToString();
        startInfo.EnvironmentVariables["AUTH_MODE"] = "owner";
        startInfo.EnvironmentVariables["OWNER_TOKEN"] = ownerToken;
        startInfo.EnvironmentVariables["OWNER_OAUTH_SCOPES"] = options.OwnerOAuthScopes;
        startInfo.EnvironmentVariables["OWNER_OAUTH_STATE_PATH"] = Path.Combine(options.RuntimeRoot, "owner-oauth-state.json");
        startInfo.EnvironmentVariables["ALLOWED_ORIGINS"] = options.AllowedOrigins;
        startInfo.EnvironmentVariables["BROWSER_WORKER_ENABLED"] = options.BrowserEnabled ? "true" : "false";
        if (options.BrowserEnabled)
        {
            startInfo.EnvironmentVariables["BROWSER_WORKER_URL"] = browserUri.GetLeftPart(UriPartial.Authority);
            startInfo.EnvironmentVariables["BROWSER_WORKER_TOKEN"] = browserToken;
        }
        else
        {
            startInfo.EnvironmentVariables.Remove("BROWSER_WORKER_URL");
            startInfo.EnvironmentVariables.Remove("BROWSER_WORKER_TOKEN");
        }

        using (Process child = new Process())
        {
            child.StartInfo = startInfo;
            child.EnableRaisingEvents = true;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                AppendLine(stdoutLog, eventArgs.Data);
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                AppendLine(stderrLog, eventArgs.Data);
            };

            if (!child.Start())
            {
                throw new InvalidOperationException("Edge Connector Node.js child did not start.");
            }
            if (!AssignProcessToJobObject(job, child.Handle))
            {
                int errorCode = Marshal.GetLastWin32Error();
                TryKill(child);
                throw new Win32Exception(errorCode, "Unable to assign Edge Connector Node.js child to the host Job Object.");
            }

            AppendEvent(
                stderrLog,
                "edge_host_child_started",
                "pid=" + child.Id.ToString() + " restartAttempt=" + restartAttempt.ToString());
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.WaitForExit();
            child.WaitForExit();
            int exitCode = child.ExitCode;
            AppendEvent(
                stderrLog,
                "edge_host_child_exited",
                "exitCode=" + exitCode.ToString() + " restartAttempt=" + restartAttempt.ToString());
            return exitCode;
        }
    }

    private static Uri ValidateEdgeOrigin(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) ||
            !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrWhiteSpace(uri.UserInfo) ||
            uri.AbsolutePath != "/" ||
            !string.IsNullOrWhiteSpace(uri.Query) ||
            !string.IsNullOrWhiteSpace(uri.Fragment))
        {
            throw new ArgumentException("Edge base URL must be a credential-free HTTPS origin.");
        }
        return uri;
    }

    private static Uri ValidateBrowserOrigin(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) ||
            !string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase) ||
            (uri.Host != "127.0.0.1" && uri.Host != "localhost" && uri.Host != "::1") ||
            !string.IsNullOrWhiteSpace(uri.UserInfo) ||
            uri.AbsolutePath != "/" ||
            !string.IsNullOrWhiteSpace(uri.Query) ||
            !string.IsNullOrWhiteSpace(uri.Fragment))
        {
            throw new ArgumentException("Browser Worker URL must be a credential-free loopback HTTP origin.");
        }
        return uri;
    }

    private static string ValidateSecretFile(string path, string name, int minimumLength, int maximumLength)
    {
        string resolved = RequireFile(path, name + " file");
        FileInfo info = new FileInfo(resolved);
        if (info.Length <= 0 || info.Length > 4096)
        {
            throw new InvalidDataException(name + " file size is invalid.");
        }
        string value = ReadSecretValue(resolved, name, minimumLength, maximumLength);
        value = null;
        return resolved;
    }

    private static string ReadSecretValue(string path, string name, int minimumLength, int maximumLength)
    {
        string value = File.ReadAllText(path, Encoding.UTF8).Trim();
        if (value.Length < minimumLength || value.Length > maximumLength ||
            value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        {
            throw new InvalidDataException(name + " file contains an invalid value.");
        }
        return value;
    }

    private static string RequireDirectory(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
        {
            throw new ArgumentException(name + " must be an absolute path.");
        }
        string resolved = Path.GetFullPath(value);
        if (!Directory.Exists(resolved))
        {
            throw new DirectoryNotFoundException(name + " was not found.");
        }
        return resolved;
    }

    private static string RequireAbsolutePath(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
        {
            throw new ArgumentException(name + " must be an absolute path.");
        }
        return Path.GetFullPath(value);
    }

    private static string RequireFile(string value, string name)
    {
        string resolved = RequireAbsolutePath(value, name);
        if (!File.Exists(resolved))
        {
            throw new FileNotFoundException(name + " was not found.", resolved);
        }
        return resolved;
    }

    private static string ResolveReleaseFile(string root, string relativePath)
    {
        string candidate = Path.GetFullPath(Path.Combine(root, relativePath));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Execution-node artifact escaped the immutable release root.");
        }
        if (!File.Exists(candidate))
        {
            throw new FileNotFoundException("Required execution-node artifact was not found.", candidate);
        }
        RejectReparsePoint(candidate, relativePath);
        return candidate;
    }

    private static void RejectReparsePoint(string path, string name)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("McpEdgeHost " + name + " must not be a reparse point.");
        }
    }

    private static Dictionary<string, object> ReadJsonObject(string path)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 4 * 1024 * 1024;
        serializer.RecursionLimit = 64;
        object value = serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null)
        {
            throw new InvalidDataException("Expected JSON object: " + Path.GetFileName(path));
        }
        return result;
    }

    private static string RequireJsonString(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required JSON string is missing: " + name);
        }
        string result = Convert.ToString(raw);
        if (string.IsNullOrWhiteSpace(result))
        {
            throw new InvalidDataException("Required JSON string is missing: " + name);
        }
        return result;
    }

    private static int RequireJsonInteger(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required JSON integer is missing: " + name);
        }
        try
        {
            return Convert.ToInt32(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Required JSON integer is invalid: " + name);
        }
    }

    private static long RequireJsonLong(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required JSON integer is missing: " + name);
        }
        try
        {
            return Convert.ToInt64(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Required JSON integer is invalid: " + name);
        }
    }

    private static IList RequireJsonList(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required JSON list is missing: " + name);
        }
        IList result = raw as IList;
        if (result == null)
        {
            throw new InvalidDataException("Required JSON list is invalid: " + name);
        }
        return result;
    }

    private static bool OptionalJsonBoolean(Dictionary<string, object> value, string name, bool fallback)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            return fallback;
        }
        try
        {
            return Convert.ToBoolean(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("JSON boolean is invalid: " + name);
        }
    }

    private static bool IsSha256(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length != 64)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool hex =
                (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F');
            if (!hex)
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsCommit(string value)
    {
        return value != null && value.Length == 40 && IsHex(value);
    }

    private static bool IsHex(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool hex =
                (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F');
            if (!hex)
            {
                return false;
            }
        }
        return true;
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

    private static bool IsBoundedText(string value, int maximumLength)
    {
        return !string.IsNullOrWhiteSpace(value) &&
            value.Length <= maximumLength &&
            value.IndexOf('\0') < 0 &&
            value.IndexOf('\r') < 0 &&
            value.IndexOf('\n') < 0;
    }

    private static int ParseInteger(string name, string value, int minimum, int maximum)
    {
        int parsed;
        if (!int.TryParse(value, out parsed) || parsed < minimum || parsed > maximum)
        {
            throw new ArgumentException("Invalid integer McpEdgeHost option: " + name);
        }
        return parsed;
    }

    private static bool ParseBoolean(string name, string value)
    {
        if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
        throw new ArgumentException("Invalid boolean McpEdgeHost option: " + name);
    }

    private static string Sha256File(string path)
    {
        using (FileStream stream = File.OpenRead(path))
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(stream);
            StringBuilder builder = new StringBuilder(hash.Length * 2);
            for (int index = 0; index < hash.Length; index++)
            {
                builder.Append(hash[index].ToString("x2"));
            }
            return builder.ToString();
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create Edge host Job Object.");
        }

        JobObjectExtendedLimitInformation information = new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, pointer, (uint)length))
            {
                int errorCode = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(errorCode, "Unable to configure Edge host Job Object.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                result.Append('\\', backslashes);
                backslashes = 0;
            }
            result.Append(character);
        }
        if (backslashes > 0)
        {
            result.Append('\\', backslashes * 2);
        }
        result.Append('"');
        return result.ToString();
    }

    private static int NormalizeExitCode(int exitCode)
    {
        return exitCode > 0 ? exitCode : 1;
    }

    private static void AppendLine(string path, string value)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrEmpty(value))
        {
            return;
        }
        try
        {
            lock (LogGate)
            {
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                File.AppendAllText(path, value + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static void AppendEvent(string path, string eventName, string detail)
    {
        string line = DateTimeOffset.UtcNow.ToString("O") + " " + eventName;
        if (!string.IsNullOrWhiteSpace(detail))
        {
            line += " " + Sanitize(detail);
        }
        AppendLine(path, line);
    }

    private static string Sanitize(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }
        string sanitized = value.Replace('\r', ' ').Replace('\n', ' ');
        return sanitized.Length <= 2048 ? sanitized : sanitized.Substring(0, 2048);
    }

    private static string TryGetErrorLogPath(Options options)
    {
        try
        {
            if (options == null || string.IsNullOrWhiteSpace(options.RuntimeRoot) || !Path.IsPathRooted(options.RuntimeRoot))
            {
                return string.Empty;
            }
            return Path.Combine(Path.GetFullPath(options.RuntimeRoot), "logs", "edge-connector.stderr.log");
        }
        catch
        {
            return string.Empty;
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (process != null && !process.HasExited)
            {
                process.Kill();
            }
        }
        catch
        {
        }
    }
}
