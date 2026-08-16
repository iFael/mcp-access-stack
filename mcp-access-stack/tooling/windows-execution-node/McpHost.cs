using System;
using System.IO;

internal static class Program
{
    private const string ContractVersion = "mcp-host-contract-v1";

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
                return ValidateReleaseRoot(args[1]);
            }

            Console.Error.WriteLine(
                "McpHost stage-2 artifact: runtime supervision is not enabled yet. " +
                "Use --version or --validate-release-root only.");
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static int ValidateReleaseRoot(string releaseRoot)
    {
        if (string.IsNullOrWhiteSpace(releaseRoot))
        {
            throw new ArgumentException("Release root is required.", "releaseRoot");
        }

        string root = Path.GetFullPath(releaseRoot);
        RequireFile(root, "manifest.json");
        RequireFile(root, "execution-node-manifest.json");
        RequireFile(root, Path.Combine("services", "workspace-agent", "dist", "cli.js"));
        RequireFile(root, Path.Combine("services", "browser-worker", "dist", "server.js"));
        RequireFile(root, Path.Combine("runtime", "node", "node.exe"));

        Console.WriteLine("release-root-valid");
        return 0;
    }

    private static void RequireFile(string root, string relativePath)
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
    }
}
