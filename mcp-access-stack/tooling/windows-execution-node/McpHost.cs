using System;
using System.Collections.Generic;

internal static class Program
{
    private const string ContractVersion = "mcp-host-contract-v3";

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
                SupervisorOptions supervisor = ParseSupervisorOptions(args);
                return ExecutionNodeSupervisor.Run(supervisor, ContractVersion);
            }

            if (args.Length >= 1 && string.Equals(args[0], "--run-active", StringComparison.Ordinal))
            {
                PersistentHostOptions persistent = ParsePersistentHostOptions(args);
                return ExecutionNodePersistence.Run(persistent, ContractVersion);
            }

            Console.Error.WriteLine(
                "McpHost supports only --version, --validate-release-root <path>, " +
                "the fixed --supervise contract, or the fixed --run-active contract.");
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
        Dictionary<string, string> values = ParseNameValueOptions(
            args,
            "--supervise",
            AllowedSupervisorOptions);

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

        ValidateEnvironment(options.EnvironmentName);
        if (!Hashing.IsSha256(options.ExpectedManifestSha256))
        {
            throw new ArgumentException("McpHost expected manifest SHA-256 is invalid.");
        }
        return options;
    }

    private static PersistentHostOptions ParsePersistentHostOptions(string[] args)
    {
        Dictionary<string, string> values = ParseNameValueOptions(
            args,
            "--run-active",
            AllowedPersistentOptions);

        PersistentHostOptions options = new PersistentHostOptions();
        options.InstallationRoot = Require(values, "installation-root");
        options.ProjectRoot = Require(values, "project-root");
        options.EnvironmentName = Require(values, "environment");
        options.CredentialBrokerPath = Optional(values, "credential-broker-path");
        options.HealthStatePath = Optional(values, "health-state-path");
        options.RestartCount = OptionalInteger(values, "restart-count", 5, 0, 100);
        options.RestartIntervalSeconds = OptionalInteger(values, "restart-interval-seconds", 5, 1, 3600);
        options.ReadinessTimeoutSeconds = OptionalInteger(values, "readiness-timeout-seconds", 45, 5, 600);

        ValidateEnvironment(options.EnvironmentName);
        return options;
    }

    private static Dictionary<string, string> ParseNameValueOptions(
        string[] args,
        string command,
        HashSet<string> allowed)
    {
        if (args.Length < 1 || !string.Equals(args[0], command, StringComparison.Ordinal))
        {
            throw new ArgumentException("Invalid McpHost command parser invocation.");
        }
        if ((args.Length - 1) % 2 != 0)
        {
            throw new ArgumentException(command + " options must be name/value pairs.");
        }

        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int index = 1; index < args.Length; index += 2)
        {
            string name = args[index];
            string value = args[index + 1];
            if (string.IsNullOrWhiteSpace(name) || !name.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Invalid McpHost option name.");
            }
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new ArgumentException("McpHost option values must not be empty.");
            }
            string key = name.Substring(2);
            if (!allowed.Contains(key) || values.ContainsKey(key))
            {
                throw new ArgumentException("Unsupported or duplicate McpHost option: " + name);
            }
            values.Add(key, value);
        }
        return values;
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

    private static readonly HashSet<string> AllowedPersistentOptions = new HashSet<string>(StringComparer.Ordinal)
    {
        "installation-root",
        "project-root",
        "environment",
        "credential-broker-path",
        "health-state-path",
        "restart-count",
        "restart-interval-seconds",
        "readiness-timeout-seconds"
    };

    private static void ValidateEnvironment(string value)
    {
        if (!string.Equals(value, "development", StringComparison.Ordinal) &&
            !string.Equals(value, "production", StringComparison.Ordinal))
        {
            throw new ArgumentException("McpHost environment must be development or production.");
        }
    }

    private static string Require(Dictionary<string, string> values, string name)
    {
        string value;
        if (!values.TryGetValue(name, out value) || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Missing required McpHost option: --" + name);
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
