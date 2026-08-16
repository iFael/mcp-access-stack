using System;
using System.Collections.Generic;
using System.IO;

internal static class Program
{
    private const string ContractVersion = "mcp-host-contract-v2";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && string.Equals(args[0], "--version", StringComparison.Ordinal))
            {
                Console.WriteLine(ContractVersion);
                return 0;
            }

            if (args.Length == 2 && string.Equals(args[0], "--validate-release-root", StringComparison.Ordinal))
            {
                ReleaseContract.Validate(args[1], null);
                Console.WriteLine("release-root-valid");
                return 0;
            }

            if (args.Length >= 1 && string.Equals(args[0], "--supervise", StringComparison.Ordinal))
            {
                SupervisorOptions options = ParseSupervisorOptions(args);
                return ExecutionNodeSupervisor.Run(options, ContractVersion);
            }

            Console.Error.WriteLine(
                "McpHost supports only --version, --validate-release-root <path>, or the fixed --supervise contract.");
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static SupervisorOptions ParseSupervisorOptions(string[] args)
    {
        if ((args.Length - 1) % 2 != 0)
        {
            throw new ArgumentException("McpHost --supervise options must be name/value pairs.");
        }

        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 1; index < args.Length; index += 2)
        {
            string name = args[index];
            string value = args[index + 1];
            if (string.IsNullOrWhiteSpace(name) || !name.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Invalid McpHost supervisor option name.");
            }
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException("McpHost supervisor option values must not be empty.");
            }
            string key = name.Substring(2);
            if (!AllowedSupervisorOptions.Contains(key) || values.ContainsKey(key))
            {
                throw new ArgumentException("Unsupported or duplicate McpHost supervisor option: " + name);
            }
            values.Add(key, value);
        }

        SupervisorOptions options = new SupervisorOptions();
        options.ReleaseRoot = Require(values, "release-root");
        options.ProjectRoot = Require(values, "project-root");
        options.EnvironmentName = Require(values, "environment");
        options.ExpectedManifestSha256 = Require(values, "expected-manifest-sha256");
        options.CredentialBrokerPath = Optional(values, "credential-broker-path");
        options.HealthStatePath = Optional(values, "health-state-path");
        options.RestartCount = OptionalInteger(values, "restart-count", 5, 0, 100);
        options.RestartIntervalSeconds = OptionalInteger(values, "restart-interval-seconds", 5, 1, 3600);
        options.ReadinessTimeoutSeconds = OptionalInteger(values, "readiness-timeout-seconds", 45, 5, 600);
        options.QualificationOwnerPid = OptionalInteger(values, "qualification-owner-pid", 0, 0, int.MaxValue);

        if (!string.Equals(options.EnvironmentName, "development", StringComparison.Ordinal) &&
            !string.Equals(options.EnvironmentName, "production", StringComparison.Ordinal))
        {
            throw new ArgumentException("McpHost environment must be development or production.");
        }
        if (!Hashing.IsSha256(options.ExpectedManifestSha256))
        {
            throw new ArgumentException("McpHost expected manifest SHA-256 is invalid.");
        }
        return options;
    }

    private static readonly HashSet<string> AllowedSupervisorOptions = new HashSet<string>(StringComparer.Ordinal)
    {
        "release-root",
        "project-root",
        "environment",
        "expected-manifest-sha256",
        "credential-broker-path",
        "health-state-path",
        "restart-count",
        "restart-interval-seconds",
        "readiness-timeout-seconds",
        "qualification-owner-pid"
    };

    private static string Require(Dictionary<string, string> values, string name)
    {
        string value;
        if (!values.TryGetValue(name, out value) || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Missing required McpHost supervisor option: --" + name);
        }
        return value;
    }

    private static string Optional(Dictionary<string, string> values, string name)
    {
        string value;
        return values.TryGetValue(name, out value) ? value : string.Empty;
    }

    private static int OptionalInteger(
        Dictionary<string, string> values,
        string name,
        int fallback,
        int minimum,
        int maximum)
    {
        string value;
        if (!values.TryGetValue(name, out value))
        {
            return fallback;
        }
        int parsed;
        if (!int.TryParse(value, out parsed) || parsed < minimum || parsed > maximum)
        {
            throw new ArgumentException("Invalid McpHost integer option: --" + name);
        }
        return parsed;
    }
}

internal sealed class SupervisorOptions
{
    public string ReleaseRoot = string.Empty;
    public string ProjectRoot = string.Empty;
    public string EnvironmentName = string.Empty;
    public string ExpectedManifestSha256 = string.Empty;
    public string CredentialBrokerPath = string.Empty;
    public string HealthStatePath = string.Empty;
    public int RestartCount;
    public int RestartIntervalSeconds;
    public int ReadinessTimeoutSeconds;
    public int QualificationOwnerPid;
}
