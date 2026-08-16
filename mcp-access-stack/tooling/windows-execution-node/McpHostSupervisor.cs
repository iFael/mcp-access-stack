using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Hashing
{
    public static bool IsSha256(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length != 64)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool hexadecimal =
                (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F');
            if (!hexadecimal)
            {
                return false;
            }
        }
        return true;
    }

    public static string Sha256File(string path)
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
}

internal sealed class ReleaseContractInfo
{
    public string Root = string.Empty;
    public string ReleaseId = string.Empty;
    public string ManifestSha256 = string.Empty;
    public string NodePath = string.Empty;
    public string AgentPath = string.Empty;
    public string BrowserPath = string.Empty;
}

internal static class ReleaseContract
{
    public static ReleaseContractInfo Validate(string releaseRoot, string expectedManifestSha256)
    {
        if (string.IsNullOrWhiteSpace(releaseRoot))
        {
            throw new ArgumentException("Release root is required.", "releaseRoot");
        }

        string root = Path.GetFullPath(releaseRoot);
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException("Execution-node release root was not found: " + root);
        }
        RejectReparsePoint(root, "release root");

        string releaseManifestPath = RequireFile(root, "manifest.json");
        string executionManifestPath = RequireFile(root, "execution-node-manifest.json");
        string agentPath = RequireFile(root, Path.Combine("services", "workspace-agent", "dist", "cli.js"));
        string browserPath = RequireFile(root, Path.Combine("services", "browser-worker", "dist", "server.js"));
        string nodePath = RequireFile(root, Path.Combine("runtime", "node", "node.exe"));

        string actualManifestHash = Hashing.Sha256File(executionManifestPath);
        if (!string.IsNullOrWhiteSpace(expectedManifestSha256) &&
            !string.Equals(actualManifestHash, expectedManifestSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Execution-node manifest hash does not match the validated state pointer.");
        }

        Dictionary<string, object> releaseManifest = JsonData.ReadObject(releaseManifestPath);
        Dictionary<string, object> executionManifest = JsonData.ReadObject(executionManifestPath);
        string releaseId = JsonData.RequireString(releaseManifest, "releaseId");
        if (!IsSafeReleaseId(releaseId))
        {
            throw new InvalidDataException("Release manifest contains an invalid releaseId.");
        }
        if (JsonData.RequireInteger(executionManifest, "version") != 1 ||
            !string.Equals(JsonData.RequireString(executionManifest, "releaseId"), releaseId, StringComparison.Ordinal) ||
            !string.Equals(JsonData.RequireString(executionManifest, "platform"), "win32-x64", StringComparison.Ordinal) ||
            !string.Equals(JsonData.RequireString(executionManifest, "runtimeMode"), "bundled-node", StringComparison.Ordinal) ||
            !string.Equals(JsonData.RequireString(executionManifest, "integrityRoot"), "signed-distribution-manifest", StringComparison.Ordinal))
        {
            throw new InvalidDataException("Execution-node manifest identity or runtime contract is invalid.");
        }

        Dictionary<string, string> expectedArtifacts = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "mcp-host", "native/McpHost.exe" },
            { "workspace-agent", "services/workspace-agent/dist/cli.js" },
            { "browser-worker", "services/browser-worker/dist/server.js" },
            { "node-runtime", "runtime/node/node.exe" }
        };
        object artifactsValue;
        if (!executionManifest.TryGetValue("artifacts", out artifactsValue))
        {
            throw new InvalidDataException("Execution-node manifest does not contain artifacts.");
        }
        IList artifacts = JsonData.RequireList(artifactsValue, "artifacts");
        if (artifacts.Count != expectedArtifacts.Count)
        {
            throw new InvalidDataException("Execution-node manifest must contain exactly four critical artifacts.");
        }

        HashSet<string> seenRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (object item in artifacts)
        {
            Dictionary<string, object> artifact = JsonData.RequireObject(item, "artifact");
            string role = JsonData.RequireString(artifact, "role");
            string path = JsonData.RequireString(artifact, "path").Replace('\\', '/');
            string expectedPath;
            if (!expectedArtifacts.TryGetValue(role, out expectedPath) ||
                !string.Equals(path, expectedPath, StringComparison.Ordinal) ||
                !seenRoles.Add(role))
            {
                throw new InvalidDataException("Execution-node artifact role/path contract is invalid: " + role);
            }

            string artifactPath = RequireFile(root, path.Replace('/', Path.DirectorySeparatorChar));
            long expectedSize = JsonData.RequireLong(artifact, "sizeBytes");
            string expectedHash = JsonData.RequireString(artifact, "sha256").ToLowerInvariant();
            if (expectedSize < 0 || !Hashing.IsSha256(expectedHash))
            {
                throw new InvalidDataException("Execution-node artifact integrity metadata is invalid: " + role);
            }
            FileInfo artifactInfo = new FileInfo(artifactPath);
            if (artifactInfo.Length != expectedSize ||
                !string.Equals(Hashing.Sha256File(artifactPath), expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Execution-node artifact changed after validation: " + role);
            }
            if (string.Equals(role, "mcp-host", StringComparison.Ordinal) &&
                !JsonData.OptionalBoolean(artifact, "authenticodeRequired", false))
            {
                throw new InvalidDataException("McpHost artifact must require Authenticode.");
            }
        }
        if (seenRoles.Count != expectedArtifacts.Count)
        {
            throw new InvalidDataException("Execution-node artifact set is incomplete.");
        }

        ReleaseContractInfo result = new ReleaseContractInfo();
        result.Root = root;
        result.ReleaseId = releaseId;
        result.ManifestSha256 = actualManifestHash;
        result.NodePath = nodePath;
        result.AgentPath = agentPath;
        result.BrowserPath = browserPath;
        return result;
    }

    private static string RequireFile(string root, string relativePath)
    {
        string candidate = Path.GetFullPath(Path.Combine(root, relativePath));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) +
            Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Release path escaped its root: " + relativePath);
        }
        if (!File.Exists(candidate))
        {
            throw new FileNotFoundException("Required execution-node file was not found.", candidate);
        }
        RejectReparsePoint(candidate, relativePath);
        return candidate;
    }

    private static void RejectReparsePoint(string path, string label)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("Execution-node " + label + " must not be a reparse point.");
        }
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
}

internal static class JsonData
{
    private static readonly JavaScriptSerializer Serializer = CreateSerializer();
    private static readonly object SerializerGate = new object();

    private static JavaScriptSerializer CreateSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 4 * 1024 * 1024;
        serializer.RecursionLimit = 64;
        return serializer;
    }

    public static Dictionary<string, object> ReadObject(string path)
    {
        lock (SerializerGate)
        {
            object value = Serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
            return RequireObject(value, path);
        }
    }

    public static Dictionary<string, object> RequireObject(object value, string label)
    {
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null)
        {
            throw new InvalidDataException("Expected JSON object: " + label);
        }
        return result;
    }

    public static IList RequireList(object value, string label)
    {
        IList list = value as IList;
        if (list == null)
        {
            throw new InvalidDataException("Expected JSON array: " + label);
        }
        return list;
    }

    public static string RequireString(Dictionary<string, object> value, string name)
    {
        object raw;
        string result = value.TryGetValue(name, out raw) && raw != null ? Convert.ToString(raw) : string.Empty;
        if (string.IsNullOrWhiteSpace(result))
        {
            throw new InvalidDataException("Required configuration string is missing: " + name);
        }
        return result;
    }

    public static string OptionalString(Dictionary<string, object> value, string name, string fallback)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            return fallback;
        }
        string result = Convert.ToString(raw);
        return string.IsNullOrWhiteSpace(result) ? fallback : result;
    }

    public static long RequireLong(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required configuration integer is missing: " + name);
        }
        try
        {
            return Convert.ToInt64(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Configuration value must be an integer: " + name);
        }
    }
    public static int RequireInteger(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            throw new InvalidDataException("Required configuration integer is missing: " + name);
        }
        try
        {
            return Convert.ToInt32(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Configuration value must be an integer: " + name);
        }
    }

    public static int OptionalInteger(Dictionary<string, object> value, string name, int fallback)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            return fallback;
        }
        try
        {
            return Convert.ToInt32(raw);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Configuration value must be an integer: " + name);
        }
    }

    public static bool OptionalBoolean(Dictionary<string, object> value, string name, bool fallback)
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
            throw new InvalidDataException("Configuration value must be boolean: " + name);
        }
    }

    public static Dictionary<string, object> OptionalObject(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            return new Dictionary<string, object>(StringComparer.Ordinal);
        }
        return RequireObject(raw, name);
    }

    public static string JoinStringArray(Dictionary<string, object> value, string name)
    {
        object raw;
        if (!value.TryGetValue(name, out raw) || raw == null)
        {
            return string.Empty;
        }
        IList list = RequireList(raw, name);
        List<string> values = new List<string>();
        foreach (object item in list)
        {
            if (item != null)
            {
                values.Add(Convert.ToString(item));
            }
        }
        return string.Join(",", values.ToArray());
    }

    public static string Serialize(object value)
    {
        lock (SerializerGate)
        {
            return Serializer.Serialize(value);
        }
    }

    public static string TryReadEvent(string line)
    {
        if (string.IsNullOrWhiteSpace(line) || line.Length > 1024 * 1024 || line[0] != '{')
        {
            return string.Empty;
        }
        try
        {
            lock (SerializerGate)
            {
                Dictionary<string, object> payload = RequireObject(Serializer.DeserializeObject(line), "diagnostic");
                return OptionalString(payload, "event", string.Empty);
            }
        }
        catch
        {
            return string.Empty;
        }
    }
}

internal sealed class ComponentDefinition
{
    public string Name = string.Empty;
    public string NodePath = string.Empty;
    public string EntryPath = string.Empty;
    public string WorkingDirectory = string.Empty;
    public readonly List<string> Arguments = new List<string>();
    public readonly Dictionary<string, string> Environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public string StandardOutputPath = string.Empty;
    public string StandardErrorPath = string.Empty;
    public bool AgentReadiness;
    public int BrowserPort;
}

internal sealed class ComponentSnapshot
{
    public string Name = string.Empty;
    public string Status = "stopped";
    public int ProcessId;
    public bool Live;
    public bool Ready;
    public bool EverReady;
    public int RestartAttempt;
    public string LastTransitionAt = string.Empty;
}

internal sealed class ComponentSupervisor
{
    private readonly object gate = new object();
    private readonly ComponentDefinition definition;
    private readonly WindowsJob job;
    private readonly int restartCount;
    private readonly int restartIntervalSeconds;
    private readonly int readinessTimeoutSeconds;
    private readonly Action<string> onFatal;
    private Thread thread;
    private Process activeProcess;
    private volatile bool stopping;
    private string status = "stopped";
    private bool live;
    private bool ready;
    private bool everReady;
    private int processId;
    private int restartAttempt;
    private string lastTransitionAt = DateTimeOffset.UtcNow.ToString("O");

    public ComponentSupervisor(
        ComponentDefinition definition,
        WindowsJob job,
        int restartCount,
        int restartIntervalSeconds,
        int readinessTimeoutSeconds,
        Action<string> onFatal)
    {
        this.definition = definition;
        this.job = job;
        this.restartCount = restartCount;
        this.restartIntervalSeconds = restartIntervalSeconds;
        this.readinessTimeoutSeconds = readinessTimeoutSeconds;
        this.onFatal = onFatal;
    }

    public void Start()
    {
        thread = new Thread(RunLoop);
        thread.IsBackground = true;
        thread.Name = "McpHost-" + definition.Name;
        thread.Start();
    }

    public void RequestStop()
    {
        stopping = true;
        Process process;
        lock (gate)
        {
            process = activeProcess;
            status = "stopping";
            ready = false;
            lastTransitionAt = DateTimeOffset.UtcNow.ToString("O");
        }
        TryKill(process);
    }

    public void Join(int milliseconds)
    {
        Thread current = thread;
        if (current != null)
        {
            current.Join(milliseconds);
        }
    }

    public ComponentSnapshot Snapshot()
    {
        lock (gate)
        {
            ComponentSnapshot snapshot = new ComponentSnapshot();
            snapshot.Name = definition.Name;
            snapshot.Status = status;
            snapshot.ProcessId = processId;
            snapshot.Live = live;
            snapshot.Ready = ready;
            snapshot.EverReady = everReady;
            snapshot.RestartAttempt = restartAttempt;
            snapshot.LastTransitionAt = lastTransitionAt;
            return snapshot;
        }
    }

    private void RunLoop()
    {
        while (!stopping)
        {
            Process process = null;
            try
            {
                process = StartChild();
                DateTimeOffset readinessDeadline = DateTimeOffset.UtcNow.AddSeconds(readinessTimeoutSeconds);
                DateTimeOffset nextBrowserProbe = DateTimeOffset.MinValue;
                bool processBecameReady = false;

                while (!stopping && !process.HasExited)
                {
                    if (!definition.AgentReadiness && DateTimeOffset.UtcNow >= nextBrowserProbe)
                    {
                        SetReady(ProbeBrowserReadiness(definition.BrowserPort));
                        nextBrowserProbe = DateTimeOffset.UtcNow.AddSeconds(1);
                    }

                    ComponentSnapshot snapshot = Snapshot();
                    if (snapshot.Ready)
                    {
                        processBecameReady = true;
                    }
                    if (!processBecameReady && DateTimeOffset.UtcNow > readinessDeadline)
                    {
                        HostLog.AppendEvent(
                            definition.StandardErrorPath,
                            "mcp_host_initial_readiness_timeout",
                            "component=" + definition.Name);
                        SetStatus("readiness-timeout", false, false, process.Id);
                        TryKill(process);
                        break;
                    }
                    process.WaitForExit(250);
                }

                if (!process.HasExited)
                {
                    TryKill(process);
                }
                process.WaitForExit();
                process.WaitForExit();
                int exitCode = process.ExitCode;
                SetStatus(stopping ? "stopped" : "exited", false, false, 0);
                HostLog.AppendEvent(
                    definition.StandardErrorPath,
                    "mcp_host_child_exited",
                    "component=" + definition.Name +
                    " exitCode=" + exitCode.ToString() +
                    " restartAttempt=" + restartAttempt.ToString());

                if (stopping)
                {
                    return;
                }
                if (restartAttempt >= restartCount)
                {
                    SetStatus("restart-exhausted", false, false, 0);
                    onFatal(definition.Name + " restart budget exhausted");
                    return;
                }
                restartAttempt++;
                SetStatus("restart-wait", false, false, 0);
                if (!SleepInterruptibly(restartIntervalSeconds * 1000))
                {
                    return;
                }
            }
            catch (Exception error)
            {
                SetStatus("failed", false, false, 0);
                HostLog.AppendEvent(
                    definition.StandardErrorPath,
                    "mcp_host_component_failed",
                    "component=" + definition.Name + " error=" + error.GetType().Name + ": " + Sanitize(error.Message));
                TryKill(process);
                if (stopping)
                {
                    return;
                }
                if (restartAttempt >= restartCount)
                {
                    onFatal(definition.Name + " supervisor failed after restart budget");
                    return;
                }
                restartAttempt++;
                if (!SleepInterruptibly(restartIntervalSeconds * 1000))
                {
                    return;
                }
            }
            finally
            {
                if (process != null)
                {
                    process.Dispose();
                }
                lock (gate)
                {
                    activeProcess = null;
                }
            }
        }
    }

    private Process StartChild()
    {
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = definition.NodePath;
        startInfo.Arguments = WindowsCommandLine.Build(definition.Arguments);
        startInfo.WorkingDirectory = definition.WorkingDirectory;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.RedirectStandardInput = false;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        foreach (KeyValuePair<string, string> pair in definition.Environment)
        {
            startInfo.EnvironmentVariables[pair.Key] = pair.Value;
        }

        Process process = new Process();
        process.StartInfo = startInfo;
        process.EnableRaisingEvents = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            HostLog.AppendLine(definition.StandardOutputPath, eventArgs.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            HostLog.AppendLine(definition.StandardErrorPath, eventArgs.Data);
            if (definition.AgentReadiness)
            {
                ObserveAgentDiagnostic(eventArgs.Data);
            }
        };

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("Execution-node child process did not start: " + definition.Name);
        }
        if (!job.Assign(process))
        {
            int errorCode = Marshal.GetLastWin32Error();
            TryKill(process);
            process.Dispose();
            throw new Win32Exception(errorCode, "Unable to assign execution-node child to the host Job Object.");
        }

        lock (gate)
        {
            activeProcess = process;
            live = true;
            ready = false;
            processId = process.Id;
            status = "starting";
            lastTransitionAt = DateTimeOffset.UtcNow.ToString("O");
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        HostLog.AppendEvent(
            definition.StandardErrorPath,
            "mcp_host_child_started",
            "component=" + definition.Name +
            " pid=" + process.Id.ToString() +
            " restartAttempt=" + restartAttempt.ToString());
        return process;
    }

    private void ObserveAgentDiagnostic(string line)
    {
        string eventName = JsonData.TryReadEvent(line);
        if (string.Equals(eventName, "connected", StringComparison.Ordinal))
        {
            SetReady(true);
        }
        else if (
            string.Equals(eventName, "disconnected", StringComparison.Ordinal) ||
            string.Equals(eventName, "reconnecting", StringComparison.Ordinal) ||
            string.Equals(eventName, "heartbeat_timeout", StringComparison.Ordinal) ||
            string.Equals(eventName, "connection_error", StringComparison.Ordinal))
        {
            SetReady(false);
        }
    }

    private void SetReady(bool value)
    {
        lock (gate)
        {
            if (!live)
            {
                value = false;
            }
            ready = value;
            if (value)
            {
                everReady = true;
                status = "ready";
            }
            else if (live && status != "starting")
            {
                status = everReady ? "degraded" : "starting";
            }
            lastTransitionAt = DateTimeOffset.UtcNow.ToString("O");
        }
    }

    private void SetStatus(string value, bool isLive, bool isReady, int pid)
    {
        lock (gate)
        {
            status = value;
            live = isLive;
            ready = isReady;
            processId = pid;
            lastTransitionAt = DateTimeOffset.UtcNow.ToString("O");
        }
    }

    private bool SleepInterruptibly(int milliseconds)
    {
        int remaining = milliseconds;
        while (!stopping && remaining > 0)
        {
            int slice = Math.Min(remaining, 250);
            Thread.Sleep(slice);
            remaining -= slice;
        }
        return !stopping;
    }

    private static bool ProbeBrowserReadiness(int port)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
            "http://127.0.0.1:" + port.ToString() + "/health/ready");
        request.Method = "GET";
        request.Timeout = 1000;
        request.ReadWriteTimeout = 1000;
        request.KeepAlive = false;
        request.Proxy = null;
        try
        {
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch (WebException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static void TryKill(Process process)
    {
        if (process == null)
        {
            return;
        }
        try
        {
            if (!process.HasExited)
            {
                process.Kill();
            }
        }
        catch
        {
        }
    }

    private static string Sanitize(string value)
    {
        return string.IsNullOrEmpty(value) ? string.Empty : value.Replace('\r', ' ').Replace('\n', ' ');
    }
}

internal static class ExecutionNodeSupervisor
{
    private static readonly ManualResetEvent StopEvent = new ManualResetEvent(false);
    private static readonly object FatalGate = new object();
    private static string fatalReason = string.Empty;

    public static int Run(SupervisorOptions options, string contractVersion)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT)
        {
            throw new PlatformNotSupportedException("McpHost supervision requires Windows.");
        }

        string projectRoot = Path.GetFullPath(options.ProjectRoot);
        if (!Directory.Exists(projectRoot))
        {
            throw new DirectoryNotFoundException("McpHost project root was not found: " + projectRoot);
        }
        RejectReparsePoint(projectRoot, "project root");

        ReleaseContractInfo release = ReleaseContract.Validate(
            options.ReleaseRoot,
            options.ExpectedManifestSha256);
        string privateRoot = Path.Combine(
            projectRoot,
            ".runtime-private",
            "docker",
            options.EnvironmentName);
        string agentConfigPath = Path.Combine(privateRoot, "agent.json");
        string browserConfigPath = Path.Combine(privateRoot, "browser.json");
        if (!Directory.Exists(privateRoot) ||
            !File.Exists(agentConfigPath) ||
            !File.Exists(browserConfigPath))
        {
            throw new FileNotFoundException("Execution-node runtime configuration is incomplete under: " + privateRoot);
        }
        RejectReparsePoint(privateRoot, "private configuration root");
        RejectReparsePoint(agentConfigPath, "agent configuration");
        RejectReparsePoint(browserConfigPath, "browser configuration");

        string credentialBrokerPath = string.Empty;
        if (!string.IsNullOrWhiteSpace(options.CredentialBrokerPath))
        {
            credentialBrokerPath = Path.GetFullPath(options.CredentialBrokerPath);
            if (!File.Exists(credentialBrokerPath))
            {
                throw new FileNotFoundException("Configured credential broker executable was not found.", credentialBrokerPath);
            }
            RejectReparsePoint(credentialBrokerPath, "credential broker");
        }

        string runtimeRoot = Path.Combine(
            projectRoot,
            "runtime",
            "windows-execution-node",
            options.EnvironmentName);
        Directory.CreateDirectory(runtimeRoot);
        RejectReparsePoint(runtimeRoot, "runtime root");
        string healthStatePath = string.IsNullOrWhiteSpace(options.HealthStatePath)
            ? Path.Combine(runtimeRoot, "host-state.json")
            : Path.GetFullPath(options.HealthStatePath);
        EnsurePathWithinRoot(runtimeRoot, healthStatePath, "health state path");

        ComponentDefinition agentDefinition = BuildAgentDefinition(
            release,
            projectRoot,
            options.EnvironmentName,
            agentConfigPath,
            runtimeRoot);
        ComponentDefinition browserDefinition = BuildBrowserDefinition(
            release,
            browserConfigPath,
            runtimeRoot,
            credentialBrokerPath);

        using (WindowsJob job = new WindowsJob())
        {
            ComponentSupervisor agent = new ComponentSupervisor(
                agentDefinition,
                job,
                options.RestartCount,
                options.RestartIntervalSeconds,
                options.ReadinessTimeoutSeconds,
                RecordFatal);
            ComponentSupervisor browser = new ComponentSupervisor(
                browserDefinition,
                job,
                options.RestartCount,
                options.RestartIntervalSeconds,
                options.ReadinessTimeoutSeconds,
                RecordFatal);

            ConsoleCancelEventHandler cancelHandler = delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                StopEvent.Set();
            };
            Console.CancelKeyPress += cancelHandler;

            try
            {
                HostLog.AppendEvent(
                    Path.Combine(runtimeRoot, "host.log"),
                    "mcp_host_supervision_started",
                    "releaseId=" + release.ReleaseId + " environment=" + options.EnvironmentName);
                agent.Start();
                browser.Start();

                while (!StopEvent.WaitOne(1000))
                {
                    WriteState(
                        healthStatePath,
                        contractVersion,
                        release,
                        options.EnvironmentName,
                        agent.Snapshot(),
                        browser.Snapshot(),
                        false);
                    if (HasFatal())
                    {
                        StopEvent.Set();
                    }
                }
            }
            finally
            {
                agent.RequestStop();
                browser.RequestStop();
                agent.Join(10000);
                browser.Join(10000);
                WriteState(
                    healthStatePath,
                    contractVersion,
                    release,
                    options.EnvironmentName,
                    agent.Snapshot(),
                    browser.Snapshot(),
                    true);
                Console.CancelKeyPress -= cancelHandler;
            }
        }

        return HasFatal() ? 1 : 0;
    }

    private static void RecordFatal(string reason)
    {
        lock (FatalGate)
        {
            if (string.IsNullOrEmpty(fatalReason))
            {
                fatalReason = reason;
            }
        }
        StopEvent.Set();
    }

    private static bool HasFatal()
    {
        lock (FatalGate)
        {
            return !string.IsNullOrEmpty(fatalReason);
        }
    }

    private static string ReadFatal()
    {
        lock (FatalGate)
        {
            return fatalReason;
        }
    }

    private static ComponentDefinition BuildAgentDefinition(
        ReleaseContractInfo release,
        string projectRoot,
        string environmentName,
        string configPath,
        string runtimeRoot)
    {
        Dictionary<string, object> configuration = JsonData.ReadObject(configPath);
        string policyPath = JsonData.RequireString(configuration, "policyPath");
        string dataDirectory = JsonData.RequireString(configuration, "dataDirectory");

        ComponentDefinition definition = new ComponentDefinition();
        definition.Name = "agent";
        definition.NodePath = release.NodePath;
        definition.EntryPath = release.AgentPath;
        definition.WorkingDirectory = release.Root;
        definition.AgentReadiness = true;
        definition.Arguments.Add(release.AgentPath);
        definition.Arguments.Add("connect");
        definition.Arguments.Add("--policy");
        definition.Arguments.Add(policyPath);
        definition.StandardOutputPath = Path.Combine(runtimeRoot, "agent", "stdout.log");
        definition.StandardErrorPath = Path.Combine(runtimeRoot, "agent", "stderr.log");

        definition.Environment["VS_CODE_GPT_GATEWAY_URL"] = JsonData.RequireString(configuration, "gatewayUrl");
        definition.Environment["VS_CODE_GPT_AGENT_ID"] = JsonData.RequireString(configuration, "agentId");
        definition.Environment["VS_CODE_GPT_AGENT_TOKEN"] = JsonData.RequireString(configuration, "token");
        definition.Environment["VS_CODE_GPT_POLICY_PATH"] = policyPath;
        definition.Environment["VS_CODE_GPT_DATA_DIR"] = dataDirectory;
        definition.Environment["VS_CODE_GPT_MAX_PAYLOAD_BYTES"] = JsonData.RequireInteger(configuration, "maxPayloadBytes").ToString();
        definition.Environment["VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS"] =
            JsonData.OptionalInteger(configuration, "maxConcurrentSynchronousShells", 4).ToString();

        Dictionary<string, object> qualified = JsonData.OptionalObject(configuration, "qualifiedCommand");
        definition.Environment["VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED"] =
            JsonData.OptionalBoolean(qualified, "qualifiedExecution", false).ToString().ToLowerInvariant();
        definition.Environment["VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED"] =
            JsonData.OptionalBoolean(qualified, "safeAutoCorrection", false).ToString().ToLowerInvariant();
        definition.Environment["VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED"] =
            JsonData.OptionalBoolean(qualified, "shadowMode", false).ToString().ToLowerInvariant();
        definition.Environment["VS_CODE_GPT_COMMAND_PROVIDER_ENABLED"] =
            JsonData.OptionalBoolean(qualified, "providerEnabled", false).ToString().ToLowerInvariant();
        definition.Environment["VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST"] =
            JsonData.JoinStringArray(qualified, "workspaceAllowlist");
        definition.Environment["VS_CODE_GPT_COMMAND_PROVIDER_MODEL"] =
            JsonData.OptionalString(qualified, "providerModel", string.Empty);
        definition.Environment["VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH"] =
            JsonData.OptionalString(qualified, "providerBrokerPath", string.Empty);
        definition.Environment["VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS"] =
            JsonData.OptionalInteger(qualified, "providerTimeoutMs", 20000).ToString();

        string gitleaksConfigured = JsonData.OptionalString(configuration, "gitleaksPath", string.Empty);
        if (!string.IsNullOrWhiteSpace(gitleaksConfigured))
        {
            string gitleaksPath = Path.IsPathRooted(gitleaksConfigured)
                ? Path.GetFullPath(gitleaksConfigured)
                : Path.GetFullPath(Path.Combine(projectRoot, gitleaksConfigured));
            if (!File.Exists(gitleaksPath))
            {
                throw new FileNotFoundException("Configured Gitleaks binary is missing.", gitleaksPath);
            }
            definition.Environment["GITLEAKS_PATH"] = gitleaksPath;
        }
        return definition;
    }

    private static ComponentDefinition BuildBrowserDefinition(
        ReleaseContractInfo release,
        string configPath,
        string runtimeRoot,
        string credentialBrokerPath)
    {
        Dictionary<string, object> configuration = JsonData.ReadObject(configPath);
        int port = JsonData.RequireInteger(configuration, "port");
        if (port < 1 || port > 65535)
        {
            throw new InvalidDataException("Browser Worker port is invalid.");
        }

        ComponentDefinition definition = new ComponentDefinition();
        definition.Name = "browser-worker";
        definition.NodePath = release.NodePath;
        definition.EntryPath = release.BrowserPath;
        definition.WorkingDirectory = release.Root;
        definition.AgentReadiness = false;
        definition.BrowserPort = port;
        definition.Arguments.Add(release.BrowserPath);
        definition.StandardOutputPath = Path.Combine(runtimeRoot, "browser-worker", "stdout.log");
        definition.StandardErrorPath = Path.Combine(runtimeRoot, "browser-worker", "stderr.log");

        definition.Environment["BROWSER_WORKER_ENGINE"] = "playwright-direct";
        definition.Environment["BROWSER_WORKER_PORT"] = port.ToString();
        definition.Environment["BROWSER_WORKER_TOKEN"] = JsonData.RequireString(configuration, "token");
        definition.Environment["BROWSER_WORKER_MODE"] = JsonData.OptionalString(configuration, "mode", "diagnostic");
        definition.Environment["BROWSER_WORKER_PROFILE_MODE"] = "persistent";
        definition.Environment["BROWSER_WORKER_BROWSER_CHANNEL"] =
            JsonData.OptionalString(configuration, "browserChannel", "chromium");
        definition.Environment["BROWSER_WORKER_USER_DATA_DIR"] =
            JsonData.RequireString(configuration, "userDataDirectory");
        definition.Environment["BROWSER_WORKER_RUNTIME_DIR"] =
            JsonData.RequireString(configuration, "runtimeDirectory");
        definition.Environment["BROWSER_WORKER_PRIVATE_DIR"] =
            JsonData.RequireString(configuration, "privateDirectory");
        definition.Environment["BROWSER_WORKER_MAX_PAYLOAD_BYTES"] =
            JsonData.RequireInteger(configuration, "maxPayloadBytes").ToString();
        definition.Environment["BROWSER_WORKER_MAX_OWNED_TABS"] =
            JsonData.OptionalInteger(configuration, "maxOwnedTabs", 8).ToString();
        definition.Environment["BROWSER_WORKER_MAX_CONCURRENT_TABS"] =
            JsonData.OptionalInteger(configuration, "maxConcurrentTabs", 4).ToString();
        definition.Environment["BROWSER_WORKER_IDEMPOTENCY_TTL_MS"] =
            JsonData.OptionalInteger(configuration, "idempotencyTtlMs", 5 * 60 * 1000).ToString();
        definition.Environment["BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES"] =
            JsonData.OptionalInteger(configuration, "idempotencyMaxEntries", 4096).ToString();
        definition.Environment["BROWSER_WORKER_CONNECT_TIMEOUT_MS"] =
            JsonData.RequireInteger(configuration, "connectTimeoutMs").ToString();
        definition.Environment["BROWSER_WORKER_OPERATION_TIMEOUT_MS"] =
            JsonData.RequireInteger(configuration, "operationTimeoutMs").ToString();
        definition.Environment["BROWSER_WORKER_ACTION_TIMEOUT_MS"] =
            JsonData.RequireInteger(configuration, "actionTimeoutMs").ToString();
        definition.Environment["BROWSER_WORKER_NAVIGATION_TIMEOUT_MS"] =
            JsonData.RequireInteger(configuration, "navigationTimeoutMs").ToString();
        definition.Environment["BROWSER_WORKER_OUTPUT_MAX_BYTES"] =
            JsonData.RequireInteger(configuration, "outputMaxBytes").ToString();
        definition.Environment["BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS"] =
            JsonData.RequireInteger(configuration, "diagnosticTimeoutMs").ToString();
        if (!string.IsNullOrWhiteSpace(credentialBrokerPath))
        {
            definition.Environment["BROWSER_WORKER_CREDENTIAL_BROKER_PATH"] = credentialBrokerPath;
        }
        return definition;
    }

    private static void WriteState(
        string path,
        string contractVersion,
        ReleaseContractInfo release,
        string environmentName,
        ComponentSnapshot agent,
        ComponentSnapshot browser,
        bool stopping)
    {
        bool fatal = HasFatal();
        string status;
        if (fatal)
        {
            status = "failed";
        }
        else if (stopping)
        {
            status = "stopped";
        }
        else if (agent.Ready && browser.Ready)
        {
            status = "ready";
        }
        else if (agent.EverReady || browser.EverReady)
        {
            status = "degraded";
        }
        else
        {
            status = "starting";
        }

        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["version"] = 1;
        payload["contractVersion"] = contractVersion;
        payload["status"] = status;
        payload["pid"] = Process.GetCurrentProcess().Id;
        payload["releaseId"] = release.ReleaseId;
        payload["executionManifestSha256"] = release.ManifestSha256;
        payload["environment"] = environmentName;
        payload["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        payload["agent"] = SnapshotValue(agent);
        payload["browserWorker"] = SnapshotValue(browser);
        if (fatal)
        {
            payload["failure"] = ReadFatal();
        }
        AtomicJson.Write(path, payload);
    }

    private static Dictionary<string, object> SnapshotValue(ComponentSnapshot snapshot)
    {
        Dictionary<string, object> value = new Dictionary<string, object>();
        value["status"] = snapshot.Status;
        value["pid"] = snapshot.ProcessId;
        value["live"] = snapshot.Live;
        value["ready"] = snapshot.Ready;
        value["restartAttempt"] = snapshot.RestartAttempt;
        value["lastTransitionAt"] = snapshot.LastTransitionAt;
        return value;
    }

    private static void RejectReparsePoint(string path, string label)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("McpHost " + label + " must not be a reparse point.");
        }
    }

    private static void EnsurePathWithinRoot(string root, string path, string label)
    {
        string resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string resolvedPath = Path.GetFullPath(path);
        string prefix = resolvedRoot + Path.DirectorySeparatorChar;
        if (!resolvedPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("McpHost " + label + " must stay within its runtime root.");
        }
    }
}

internal static class WindowsCommandLine
{
    public static string Build(IList<string> arguments)
    {
        StringBuilder commandLine = new StringBuilder();
        for (int index = 0; index < arguments.Count; index++)
        {
            if (index > 0)
            {
                commandLine.Append(' ');
            }
            commandLine.Append(Quote(arguments[index]));
        }
        return commandLine.ToString();
    }

    private static string Quote(string value)
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
}

internal static class AtomicJson
{
    private const int WriteRetryCount = 20;
    private const int WriteRetryDelayMilliseconds = 25;

    public static void Write(string path, object value)
    {
        string resolvedPath = Path.GetFullPath(path);
        string directory = Path.GetDirectoryName(resolvedPath);
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new InvalidDataException("Host state path has no parent directory.");
        }
        Directory.CreateDirectory(directory);
        string temporary = resolvedPath + ".tmp." + Guid.NewGuid().ToString("N");
        Exception lastError = null;
        try
        {
            File.WriteAllText(
                temporary,
                JsonData.Serialize(value) + Environment.NewLine,
                new UTF8Encoding(false));

            for (int attempt = 0; attempt <= WriteRetryCount; attempt++)
            {
                try
                {
                    if (File.Exists(resolvedPath))
                    {
                        File.Replace(temporary, resolvedPath, null, true);
                    }
                    else
                    {
                        File.Move(temporary, resolvedPath);
                    }
                    return;
                }
                catch (IOException error)
                {
                    lastError = error;
                }
                catch (UnauthorizedAccessException error)
                {
                    lastError = error;
                }

                if (attempt < WriteRetryCount)
                {
                    Thread.Sleep(WriteRetryDelayMilliseconds);
                }
            }
            throw new IOException("Host state update failed after bounded retries.", lastError);
        }
        finally
        {
            try
            {
                if (File.Exists(temporary))
                {
                    File.Delete(temporary);
                }
            }
            catch
            {
            }
        }
    }
}

internal static class HostLog
{
    private static readonly object Gate = new object();

    public static void AppendLine(string path, string value)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrEmpty(value))
        {
            return;
        }
        try
        {
            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }
            lock (Gate)
            {
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

    public static void AppendEvent(string path, string eventName, string detail)
    {
        string line = DateTimeOffset.UtcNow.ToString("O") + " " + eventName;
        if (!string.IsNullOrWhiteSpace(detail))
        {
            line += " " + detail.Replace('\r', ' ').Replace('\n', ' ');
        }
        AppendLine(path, line);
    }
}

internal sealed class WindowsJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private IntPtr handle;

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

    public WindowsJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create McpHost Job Object.");
        }

        JobObjectExtendedLimitInformation information = new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformationClass,
                buffer,
                (uint)length))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure McpHost Job Object.");
            }
        }
        catch
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public bool Assign(Process process)
    {
        return AssignProcessToJobObject(handle, process.Handle);
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}
