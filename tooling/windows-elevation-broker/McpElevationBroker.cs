using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class McpElevationBrokerProgram
{
    private const int ProtocolVersion = 1;
    private const int MaxRequestBytes = 131072;
    private const int MaxCommandChars = 32000;
    private const int MaxOutputChars = 100000;
    private const int PollMilliseconds = 100;

    private sealed class ElevationRequest
    {
        public int version { get; set; }
        public string nonce { get; set; }
        public string shell { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public int timeoutMs { get; set; }
        public string responsePath { get; set; }
        public string cancelPath { get; set; }
    }

    private sealed class ElevationResponse
    {
        public int version { get; set; }
        public string nonce { get; set; }
        public int? exitCode { get; set; }
        public string stdout { get; set; }
        public string stderr { get; set; }
        public bool timedOut { get; set; }
        public bool cancelled { get; set; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Dictionary<string, string> values = ParseArguments(args);
            string requestPath = Path.GetFullPath(Require(values, "request"));
            string expectedSha256 = Require(values, "sha256").ToLowerInvariant();
            string expectedNonce = Require(values, "nonce");

            ValidateNonce(expectedNonce);
            if (!Regex.IsMatch(expectedSha256, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant))
            {
                throw new InvalidDataException("Elevation request hash is invalid.");
            }

            byte[] requestBytes = ReadBoundedFile(requestPath, MaxRequestBytes);
            try
            {
                string actualSha256 = Sha256Hex(requestBytes);
                if (!FixedTimeEquals(actualSha256, expectedSha256))
                {
                    throw new UnauthorizedAccessException("Elevation request hash mismatch.");
                }

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaxRequestBytes;
                ElevationRequest request = serializer.Deserialize<ElevationRequest>(
                    Encoding.UTF8.GetString(requestBytes));
                ValidateRequest(request, requestPath, expectedNonce);

                ElevationResponse response = Execute(request);
                WriteResponseAtomic(serializer, request, response);
                return 0;
            }
            finally
            {
                Array.Clear(requestBytes, 0, requestBytes.Length);
            }
        }
        catch
        {
            return 1;
        }
    }

    private static ElevationResponse Execute(ElevationRequest request)
    {
        string executable;
        List<string> arguments;
        try
        {
            ResolveShell(request.shell, request.command, request.cwd, out executable, out arguments);
        }
        catch (Exception error)
        {
            return NewResponse(request, null, String.Empty, Bound(error.Message), false, false);
        }

        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = BuildCommandLine(arguments),
            WorkingDirectory = request.cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        object outputGate = new object();

        try
        {
            using (Process process = new Process { StartInfo = startInfo, EnableRaisingEvents = true })
            {
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    AppendCapped(stdout, eventArgs.Data, outputGate);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    AppendCapped(stderr, eventArgs.Data, outputGate);
                };

                if (!process.Start())
                {
                    throw new InvalidOperationException("Elevated shell process did not start.");
                }
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                Stopwatch timer = Stopwatch.StartNew();
                bool timedOut = false;
                bool cancelled = false;
                while (!process.WaitForExit(PollMilliseconds))
                {
                    if (IsCancelled(request.cancelPath, request.nonce))
                    {
                        cancelled = true;
                        TryKill(process);
                        break;
                    }
                    if (timer.ElapsedMilliseconds >= request.timeoutMs)
                    {
                        timedOut = true;
                        TryKill(process);
                        break;
                    }
                }

                process.WaitForExit();
                string safeStdout;
                string safeStderr;
                lock (outputGate)
                {
                    safeStdout = stdout.ToString();
                    safeStderr = stderr.ToString();
                }

                return NewResponse(
                    request,
                    timedOut || cancelled ? (int?)null : process.ExitCode,
                    safeStdout,
                    safeStderr,
                    timedOut,
                    cancelled);
            }
        }
        catch (Win32Exception error)
        {
            return NewResponse(
                request,
                null,
                String.Empty,
                Bound(error.Message),
                false,
                false);
        }
        catch (Exception error)
        {
            return NewResponse(
                request,
                null,
                String.Empty,
                Bound(error.Message),
                false,
                false);
        }
    }

    private static void ValidateRequest(
        ElevationRequest request,
        string requestPath,
        string expectedNonce)
    {
        if (request == null || request.version != ProtocolVersion)
        {
            throw new InvalidDataException("Elevation request version is invalid.");
        }
        ValidateNonce(request.nonce);
        if (!String.Equals(request.nonce, expectedNonce, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("Elevation request nonce mismatch.");
        }
        if (!Regex.IsMatch(
                request.shell ?? String.Empty,
                "^(powershell|pwsh|cmd)$",
                RegexOptions.CultureInvariant))
        {
            throw new InvalidDataException("Elevated shell is unsupported.");
        }
        if (String.IsNullOrWhiteSpace(request.command) ||
            request.command.Length > MaxCommandChars ||
            request.command.IndexOf('\0') >= 0)
        {
            throw new InvalidDataException("Elevated command is invalid.");
        }
        if (String.IsNullOrWhiteSpace(request.cwd) ||
            !Path.IsPathRooted(request.cwd) ||
            !Directory.Exists(request.cwd) ||
            request.cwd.IndexOf('\0') >= 0)
        {
            throw new InvalidDataException("Elevated working directory is invalid.");
        }
        if (request.timeoutMs < 1 || request.timeoutMs > 300000)
        {
            throw new InvalidDataException("Elevated timeout is invalid.");
        }

        string requestDirectory = Path.GetDirectoryName(requestPath);
        if (String.IsNullOrWhiteSpace(requestDirectory) ||
            !String.Equals(
                new DirectoryInfo(requestDirectory).Name,
                "elevation",
                StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("Elevation request directory is invalid.");
        }

        string expectedRequestName = "request-" + request.nonce + ".json";
        if (!String.Equals(
                Path.GetFileName(requestPath),
                expectedRequestName,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("Elevation request file name is invalid.");
        }

        string responsePath = ValidateSiblingPath(
            requestDirectory,
            request.responsePath,
            "response-" + request.nonce + ".json");
        string cancelPath = ValidateSiblingPath(
            requestDirectory,
            request.cancelPath,
            "request-" + request.nonce + ".cancel");

        request.cwd = Path.GetFullPath(request.cwd);
        request.responsePath = responsePath;
        request.cancelPath = cancelPath;
    }

    private static string ValidateSiblingPath(
        string directory,
        string candidate,
        string expectedName)
    {
        if (String.IsNullOrWhiteSpace(candidate))
        {
            throw new InvalidDataException("Elevation path is missing.");
        }
        string full = Path.GetFullPath(candidate);
        string parent = Path.GetDirectoryName(full);
        if (!String.Equals(
                parent,
                directory,
                StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(
                Path.GetFileName(full),
                expectedName,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException("Elevation path escaped its private directory.");
        }
        return full;
    }

    private static bool IsCancelled(string cancelPath, string nonce)
    {
        try
        {
            if (!File.Exists(cancelPath))
            {
                return false;
            }
            string value = File.ReadAllText(cancelPath, Encoding.UTF8).Trim();
            return String.Equals(value, nonce, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static void WriteResponseAtomic(
        JavaScriptSerializer serializer,
        ElevationRequest request,
        ElevationResponse response)
    {
        string json = serializer.Serialize(response);
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        string temporary = request.responsePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (FileStream stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            if (File.Exists(request.responsePath))
            {
                File.Delete(request.responsePath);
            }
            File.Move(temporary, request.responsePath);
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
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

    private static ElevationResponse NewResponse(
        ElevationRequest request,
        int? exitCode,
        string stdout,
        string stderr,
        bool timedOut,
        bool cancelled)
    {
        return new ElevationResponse
        {
            version = ProtocolVersion,
            nonce = request.nonce,
            exitCode = exitCode,
            stdout = Bound(stdout),
            stderr = Bound(stderr),
            timedOut = timedOut,
            cancelled = cancelled
        };
    }

    private static void ResolveShell(
        string shell,
        string command,
        string cwd,
        out string executable,
        out List<string> arguments)
    {
        arguments = new List<string>();
        if (shell == "powershell")
        {
            executable = "powershell.exe";
            arguments.Add("-NoProfile");
            arguments.Add("-NonInteractive");
            arguments.Add("-ExecutionPolicy");
            arguments.Add("Bypass");
            arguments.Add("-Command");
            arguments.Add(command);
            return;
        }
        if (shell == "pwsh")
        {
            executable = "pwsh.exe";
            arguments.Add("-NoLogo");
            arguments.Add("-NoProfile");
            arguments.Add("-NonInteractive");
            arguments.Add("-Command");
            arguments.Add(command);
            return;
        }
        if (shell == "cmd")
        {
            executable = "cmd.exe";
            arguments.Add("/d");
            arguments.Add("/s");
            arguments.Add("/c");
            arguments.Add(command);
            return;
        }
        throw new InvalidDataException("Elevated shell is unsupported.");
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        Dictionary<string, string> values =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length ||
                !args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Invalid elevation broker argument sequence.");
            }
            string key = args[index].Substring(2);
            if (values.ContainsKey(key))
            {
                throw new ArgumentException("Duplicate elevation broker argument.");
            }
            values[key] = args[index + 1];
        }
        return values;
    }

    private static string Require(
        Dictionary<string, string> values,
        string name)
    {
        string value;
        if (!values.TryGetValue(name, out value) ||
            String.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Missing elevation broker argument.");
        }
        return value;
    }

    private static void ValidateNonce(string nonce)
    {
        if (String.IsNullOrWhiteSpace(nonce) ||
            !Regex.IsMatch(
                nonce,
                "^[A-Za-z0-9_-]{20,128}$",
                RegexOptions.CultureInvariant))
        {
            throw new UnauthorizedAccessException("Elevation nonce is invalid.");
        }
    }

    private static byte[] ReadBoundedFile(string path, int maximumBytes)
    {
        FileInfo info = new FileInfo(path);
        if (!info.Exists || info.Length <= 0 || info.Length > maximumBytes)
        {
            throw new InvalidDataException("Elevation request file is invalid.");
        }
        return File.ReadAllBytes(path);
    }

    private static string Sha256Hex(byte[] value)
    {
        using (SHA256 hash = SHA256.Create())
        {
            byte[] digest = hash.ComputeHash(value);
            try
            {
                StringBuilder result = new StringBuilder(digest.Length * 2);
                for (int index = 0; index < digest.Length; index++)
                {
                    result.Append(digest[index].ToString("x2"));
                }
                return result.ToString();
            }
            finally
            {
                Array.Clear(digest, 0, digest.Length);
            }
        }
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length)
        {
            return false;
        }
        int difference = 0;
        for (int index = 0; index < left.Length; index++)
        {
            difference |= left[index] ^ right[index];
        }
        return difference == 0;
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
        if (value.Length > 0 &&
            value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
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

    private static void AppendCapped(
        StringBuilder buffer,
        string value,
        object gate)
    {
        if (value == null)
        {
            return;
        }
        lock (gate)
        {
            if (buffer.Length >= MaxOutputChars)
            {
                return;
            }
            string line = value + Environment.NewLine;
            int remaining = MaxOutputChars - buffer.Length;
            buffer.Append(
                line.Length <= remaining
                    ? line
                    : line.Substring(0, remaining));
        }
    }

    private static string Bound(string value)
    {
        string resolved = value ?? String.Empty;
        return resolved.Length <= MaxOutputChars
            ? resolved
            : resolved.Substring(0, MaxOutputChars);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (process.HasExited)
            {
                return;
            }

            ProcessStartInfo treeKill = new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments =
                    "/PID " + process.Id.ToString() + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process killer = Process.Start(treeKill))
            {
                if (killer != null)
                {
                    killer.WaitForExit(5000);
                }
            }
        }
        catch
        {
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
}
