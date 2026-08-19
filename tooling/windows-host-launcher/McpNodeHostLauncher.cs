using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
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

    private sealed class LauncherOptions
    {
        public string NodePath = string.Empty;
        public string NodeRuntimeRoot = string.Empty;
        public string NodeReleaseId = string.Empty;
        public string StandardOutputPath = string.Empty;
        public string StandardErrorPath = string.Empty;
        public int RunnerRestartCount = 0;
        public int RunnerRestartIntervalSeconds = 60;
        public readonly List<string> NodeArguments = new List<string>();
        public readonly Dictionary<string, string> EnvironmentValues = new Dictionary<string, string>(StringComparer.Ordinal);
        public readonly Dictionary<string, string> EnvironmentFileValues = new Dictionary<string, string>(StringComparer.Ordinal);
    }

    private static int Main(string[] args)
    {
        LauncherOptions options = null;
        IntPtr job = IntPtr.Zero;

        try
        {
            options = ParseArguments(args);
            ValidateOptions(options);
            EnsureLogDirectory(options.StandardOutputPath);
            EnsureLogDirectory(options.StandardErrorPath);

            AppendEvent(
                options.StandardErrorPath,
                "native_launcher_starting",
                "runnerRestartCount=" + options.RunnerRestartCount.ToString() +
                " runnerRestartIntervalSeconds=" + options.RunnerRestartIntervalSeconds.ToString());
            job = CreateKillOnCloseJob();

            int restartAttempt = 0;
            while (true)
            {
                int exitCode;
                try
                {
                    exitCode = RunNodeChild(options, job, restartAttempt);
                }
                catch (Exception error)
                {
                    AppendEvent(
                        options.StandardErrorPath,
                        "native_launcher_child_failed",
                        error.GetType().Name + ": " + error.Message +
                        " restartAttempt=" + restartAttempt.ToString());
                    exitCode = 1;
                }

                if (exitCode == 0)
                {
                    return 0;
                }

                if (
                    options.RunnerRestartCount > 0 &&
                    restartAttempt >= options.RunnerRestartCount
                )
                {
                    AppendEvent(
                        options.StandardErrorPath,
                        "native_launcher_restart_exhausted",
                        "exitCode=" + exitCode.ToString() +
                        " restartAttempt=" + restartAttempt.ToString());
                    return NormalizeExitCode(exitCode);
                }

                restartAttempt++;
                AppendEvent(
                    options.StandardErrorPath,
                    "native_launcher_child_restart_scheduled",
                    "exitCode=" + exitCode.ToString() +
                    " restartAttempt=" + restartAttempt.ToString() +
                    " delaySeconds=" + options.RunnerRestartIntervalSeconds.ToString());
                Thread.Sleep(TimeSpan.FromSeconds(options.RunnerRestartIntervalSeconds));
            }
        }
        catch (Exception error)
        {
            string errorPath = options == null ? string.Empty : options.StandardErrorPath;
            AppendEvent(errorPath, "native_launcher_failed", error.GetType().Name + ": " + error.Message);
            return 1;
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
        }
    }

    private static int RunNodeChild(LauncherOptions options, IntPtr job, int restartAttempt)
    {
        string nodePath = ResolveNodePath(options);
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = BuildCommandLine(options.NodeArguments),
            WorkingDirectory = ResolveWorkingDirectory(options.NodeArguments),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        ApplyChildEnvironment(startInfo, options);

        using (Process child = new Process { StartInfo = startInfo, EnableRaisingEvents = true })
        {
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                AppendLine(options.StandardOutputPath, eventArgs.Data);
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                AppendLine(options.StandardErrorPath, eventArgs.Data);
            };

            if (!child.Start())
            {
                throw new InvalidOperationException("Node.js process did not start.");
            }

            if (!AssignProcessToJobObject(job, child.Handle))
            {
                int errorCode = Marshal.GetLastWin32Error();
                TryKill(child);
                throw new Win32Exception(errorCode, "Unable to assign Node.js to the launcher Job Object.");
            }

            AppendEvent(
                options.StandardErrorPath,
                "native_launcher_child_started",
                child.Id.ToString() + " restartAttempt=" + restartAttempt.ToString());
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.WaitForExit();
            child.WaitForExit();

            int exitCode = child.ExitCode;
            AppendEvent(
                options.StandardErrorPath,
                "native_launcher_child_exited",
                exitCode.ToString() + " restartAttempt=" + restartAttempt.ToString());
            return exitCode;
        }
    }

    private static string ResolveNodePath(LauncherOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.NodePath))
        {
            return options.NodePath;
        }

        string stateDirectory = Path.Combine(options.NodeRuntimeRoot, "release-state", options.NodeReleaseId);
        string pointerPath = Path.Combine(stateDirectory, "known-good.txt");
        if (!File.Exists(pointerPath))
        {
            throw new FileNotFoundException("Managed Node.js known-good pointer was not found.", pointerPath);
        }

        string version = File.ReadAllText(pointerPath, Encoding.UTF8).Trim();
        if (!IsSafeNodeVersion(version))
        {
            throw new InvalidDataException("Managed Node.js known-good pointer is invalid.");
        }

        string nodePath = Path.Combine(options.NodeRuntimeRoot, version, "node.exe");
        if (!File.Exists(nodePath))
        {
            throw new FileNotFoundException("Managed Node.js executable was not found.", nodePath);
        }

        string actualVersion = ReadNodeVersion(nodePath);
        if (!string.Equals(actualVersion, version, StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "Managed Node.js runtime version mismatch: expected=" + version + " actual=" + actualVersion);
        }
        return nodePath;
    }

    private static string ReadNodeVersion(string nodePath)
    {
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "--version",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (Process process = Process.Start(startInfo))
        {
            if (process == null)
            {
                throw new InvalidOperationException("Unable to start Node.js version probe.");
            }
            string output = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit();
            if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(output))
            {
                throw new InvalidOperationException("Node.js version probe failed.");
            }
            return output;
        }
    }

    private static bool IsSafeNodeVersion(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32 || value[0] != 'v')
        {
            return false;
        }
        string[] parts = value.Substring(1).Split('.');
        if (parts.Length != 3)
        {
            return false;
        }
        for (int index = 0; index < parts.Length; index++)
        {
            int parsed;
            if (parts[index].Length == 0 || !int.TryParse(parts[index], out parsed) || parsed < 0)
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
    private static int NormalizeExitCode(int exitCode)
    {
        return exitCode > 0 ? exitCode : 1;
    }

    private static LauncherOptions ParseArguments(string[] args)
    {
        LauncherOptions options = new LauncherOptions();
        int index = 0;

        while (index < args.Length)
        {
            string current = args[index];
            if (current == "--")
            {
                index++;
                break;
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException("Missing value for launcher argument: " + current);
            }

            string value = args[index + 1];
            if (current == "--node")
            {
                options.NodePath = value;
            }
            else if (current == "--node-runtime-root")
            {
                options.NodeRuntimeRoot = value;
            }
            else if (current == "--node-release-id")
            {
                options.NodeReleaseId = value;
            }
            else if (current == "--stdout-log")
            {
                options.StandardOutputPath = value;
            }
            else if (current == "--stderr-log")
            {
                options.StandardErrorPath = value;
            }
            else if (current == "--runner-restart-count")
            {
                options.RunnerRestartCount = ParseIntegerArgument(
                    current,
                    value,
                    0,
                    1000);
            }
            else if (current == "--runner-restart-interval-seconds")
            {
                options.RunnerRestartIntervalSeconds = ParseIntegerArgument(
                    current,
                    value,
                    1,
                    3600);
            }
            else if (current == "--env")
            {
                AddEnvironmentAssignment(options, current, value, false);
            }
            else if (current == "--env-file")
            {
                AddEnvironmentAssignment(options, current, value, true);
            }
            else
            {
                throw new ArgumentException("Unsupported launcher argument: " + current);
            }

            index += 2;
        }

        for (; index < args.Length; index++)
        {
            options.NodeArguments.Add(args[index]);
        }

        return options;
    }

    private static void AddEnvironmentAssignment(
        LauncherOptions options,
        string optionName,
        string assignment,
        bool fromFile)
    {
        int separator = assignment.IndexOf('=');
        if (separator <= 0 || separator == assignment.Length - 1)
        {
            throw new ArgumentException("Invalid environment assignment for launcher argument: " + optionName);
        }

        string name = assignment.Substring(0, separator);
        string value = assignment.Substring(separator + 1);
        if (!IsSafeEnvironmentName(name))
        {
            throw new ArgumentException("Invalid environment variable name for launcher argument: " + optionName);
        }
        if (options.EnvironmentValues.ContainsKey(name) || options.EnvironmentFileValues.ContainsKey(name))
        {
            throw new ArgumentException("Duplicate environment variable for launcher argument: " + name);
        }

        if (fromFile)
        {
            if (!Path.IsPathRooted(value) || !File.Exists(value))
            {
                throw new FileNotFoundException("Environment value file was not found.", value);
            }
            FileInfo info = new FileInfo(value);
            if (info.Length <= 0 || info.Length > 4096)
            {
                throw new InvalidDataException("Environment value file size is invalid.");
            }
            options.EnvironmentFileValues.Add(name, value);
        }
        else
        {
            if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new ArgumentException("Environment value contains an invalid control character: " + name);
            }
            options.EnvironmentValues.Add(name, value);
        }
    }

    private static bool IsSafeEnvironmentName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool safe =
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') ||
                character == '_';
            if (!safe)
            {
                return false;
            }
        }
        return true;
    }

    private static string ReadEnvironmentFileValue(string path)
    {
        string value = File.ReadAllText(path, Encoding.UTF8).Trim();
        if (value.Length == 0 || value.Length > 4096 ||
            value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
        {
            throw new InvalidDataException("Environment value file contains an invalid value.");
        }
        return value;
    }

    private static void ApplyChildEnvironment(ProcessStartInfo startInfo, LauncherOptions options)
    {
        foreach (KeyValuePair<string, string> pair in options.EnvironmentValues)
        {
            startInfo.EnvironmentVariables[pair.Key] = pair.Value;
        }
        foreach (KeyValuePair<string, string> pair in options.EnvironmentFileValues)
        {
            startInfo.EnvironmentVariables[pair.Key] = ReadEnvironmentFileValue(pair.Value);
        }
    }

    private static int ParseIntegerArgument(
        string name,
        string value,
        int minimum,
        int maximum)
    {
        int parsed;
        if (
            !int.TryParse(value, out parsed) ||
            parsed < minimum ||
            parsed > maximum
        )
        {
            throw new ArgumentException("Invalid integer launcher argument: " + name);
        }
        return parsed;
    }

    private static void ValidateOptions(LauncherOptions options)
    {
        bool hasDirectNode = !string.IsNullOrWhiteSpace(options.NodePath);
        bool hasManagedNode = !string.IsNullOrWhiteSpace(options.NodeRuntimeRoot) || !string.IsNullOrWhiteSpace(options.NodeReleaseId);
        if (hasDirectNode == hasManagedNode)
        {
            throw new ArgumentException("Configure either --node or the managed --node-runtime-root/--node-release-id pair.");
        }
        if (hasDirectNode)
        {
            if (!Path.IsPathRooted(options.NodePath) || !File.Exists(options.NodePath))
            {
                throw new FileNotFoundException("Node.js executable was not found.", options.NodePath);
            }
        }
        else
        {
            if (!Path.IsPathRooted(options.NodeRuntimeRoot) || !Directory.Exists(options.NodeRuntimeRoot))
            {
                throw new DirectoryNotFoundException("Managed Node.js runtime root was not found: " + options.NodeRuntimeRoot);
            }
            if (!IsSafeReleaseId(options.NodeReleaseId))
            {
                throw new ArgumentException("--node-release-id is invalid.");
            }
            ResolveNodePath(options);
        }
        if (string.IsNullOrWhiteSpace(options.StandardOutputPath) || !Path.IsPathRooted(options.StandardOutputPath))
        {
            throw new ArgumentException("--stdout-log must be an absolute path.");
        }
        if (string.IsNullOrWhiteSpace(options.StandardErrorPath) || !Path.IsPathRooted(options.StandardErrorPath))
        {
            throw new ArgumentException("--stderr-log must be an absolute path.");
        }
        if (options.NodeArguments.Count == 0)
        {
            throw new ArgumentException("At least one Node.js argument is required after --.");
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create launcher Job Object.");
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
                throw new Win32Exception(errorCode, "Unable to configure launcher Job Object.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }

        return job;
    }

    private static string ResolveWorkingDirectory(IList<string> nodeArguments)
    {
        string entrypoint = nodeArguments.Count > 0 ? nodeArguments[0] : string.Empty;
        if (Path.IsPathRooted(entrypoint))
        {
            string directory = Path.GetDirectoryName(entrypoint);
            if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory))
            {
                return directory;
            }
        }
        return Environment.CurrentDirectory;
    }

    private static string BuildCommandLine(IList<string> arguments)
    {
        StringBuilder commandLine = new StringBuilder();
        for (int index = 0; index < arguments.Count; index++)
        {
            if (index > 0)
            {
                commandLine.Append(' ');
            }
            commandLine.Append(QuoteWindowsArgument(arguments[index]));
        }
        return commandLine.ToString();
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

    private static void EnsureLogDirectory(string path)
    {
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    private static void AppendLine(string path, string value)
    {
        if (string.IsNullOrEmpty(value) || string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            lock (LogGate)
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

    private static void AppendEvent(string path, string eventName, string detail)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        string line = DateTimeOffset.UtcNow.ToString("O") + " " + eventName;
        if (!string.IsNullOrWhiteSpace(detail))
        {
            line += " " + detail.Replace('\r', ' ').Replace('\n', ' ');
        }
        AppendLine(path, line);
    }

    private static void TryKill(Process process)
    {
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
}
