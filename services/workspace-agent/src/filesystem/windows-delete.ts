import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";

// Fixed native helper: no caller-supplied script or command-line fragments.
// Every directory is held without write/delete sharing until disposition.
// Hash and disposition use the same exclusive-for-mutation file handle.
export const WINDOWS_DELETE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class McpHandleDelete {
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte disposition, uint size);
  static bool SamePath(SafeFileHandle handle, string expected) {
    StringBuilder name = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
    if (length == 0 || length >= name.Capacity) return false;
    string actual = name.ToString();
    string wanted = @"\\?\" + expected;
    // Only the drive letter is case-insensitive. Case-sensitive directories
    // must not allow a different object to pass the canonical-path check.
    return actual.Length == wanted.Length && actual.Length >= 7 &&
      Char.ToUpperInvariant(actual[4]) == Char.ToUpperInvariant(wanted[4]) &&
      actual.Substring(0,4) == wanted.Substring(0,4) &&
      actual.Substring(5) == wanted.Substring(5);
  }
  public static int Delete(string target, string expectedHash, long limit) {
    if (target.Length < 4 || !Char.IsLetter(target[0]) || target[1] != ':' ||
        target[2] != '\\' || target.Substring(2).Contains(":") || limit < 1 ||
        limit > 67108864 || expectedHash.Length != 64) return 10;
    var parents = new List<SafeFileHandle>();
    var names = new List<string>();
    try {
      string directory = Path.GetPathRoot(target);
      string[] segments = target.Substring(directory.Length).Split('\\');
      for (int i = 0; i < segments.Length; i++) {
        if (segments[i].Length == 0 || segments[i] == "." || segments[i] == ".." ||
            segments[i].EndsWith(".") || segments[i].EndsWith(" ")) return 10;
        // READ_ATTRIBUTES, FILE_SHARE_READ only, OPEN_EXISTING,
        // BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
        SafeFileHandle parent = CreateFileW(@"\\?\" + directory, 0x80, 1,
          IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        parents.Add(parent);
        names.Add(directory);
        Info pi;
        if (parent.IsInvalid) return 11;
        if (!GetFileInformationByHandle(parent, out pi) ||
            (pi.Attributes & 0x410) != 0x10 || !SamePath(parent, directory)) return 10;
        directory = Path.Combine(directory, segments[i]);
      }
      // GENERIC_READ | DELETE, FILE_SHARE_READ only, OPEN_REPARSE_POINT.
      using (SafeFileHandle file = CreateFileW(@"\\?\" + target, 0x80010000, 1,
        IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (file.IsInvalid) return 11;
        Info fi;
        if (GetFileType(file) != 1 || !GetFileInformationByHandle(file, out fi) ||
            (fi.Attributes & 0x410) != 0 || fi.Links != 1 || !SamePath(file, target)) return 10;
        ulong size = ((ulong)fi.SizeHigh << 32) | fi.SizeLow;
        if (size > (ulong)limit) return 12;
        using (FileStream stream = new FileStream(file, FileAccess.Read, 65536, false))
        using (SHA256 hash = SHA256.Create()) {
          // Bound the read even if the backing filesystem violates sharing.
          byte[] buffer = new byte[65536];
          long remaining = (long)size;
          while (remaining > 0) {
            int n = stream.Read(buffer, 0, (int)Math.Min(remaining, buffer.Length));
            if (n <= 0) return 10;
            hash.TransformBlock(buffer, 0, n, buffer, 0);
            remaining -= n;
          }
          if (stream.ReadByte() != -1) return 10;
          hash.TransformFinalBlock(new byte[0], 0, 0);
          string digest = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
          if (!String.Equals(digest, expectedHash, StringComparison.Ordinal)) return 10;
          Info latest;
          if (!GetFileInformationByHandle(file, out latest) ||
              latest.Volume != fi.Volume || latest.IndexHigh != fi.IndexHigh ||
              latest.IndexLow != fi.IndexLow || latest.Links != 1 ||
              latest.SizeHigh != fi.SizeHigh || latest.SizeLow != fi.SizeLow ||
              latest.Write.dwHighDateTime != fi.Write.dwHighDateTime ||
              latest.Write.dwLowDateTime != fi.Write.dwLowDateTime ||
              (latest.Attributes & 0x410) != 0 || !SamePath(file, target)) return 10;
          for (int i = 0; i < parents.Count; i++) {
            Info pi;
            if (!GetFileInformationByHandle(parents[i], out pi) ||
                (pi.Attributes & 0x410) != 0x10 || !SamePath(parents[i], names[i])) return 10;
          }
          byte delete = 1;
          if (!SetFileInformationByHandle(file, 4, ref delete, 1)) return 11;
        }
      }
      return 0;
    } finally {
      for (int i = parents.Count - 1; i >= 0; i--) parents[i].Dispose();
    }
  }
}
'@
  $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MCP_HANDLE_DELETE_REQUEST)) | ConvertFrom-Json
  exit ([McpHandleDelete]::Delete([string]$request.target, [string]$request.hash, [long]$request.limit))
} catch {
  exit 13
}
`;

export async function deleteWindowsFile(target: string, expectedSha256: string, limit: number): Promise<void> {
  if (process.platform !== "win32" || !/^[a-z]:\\/iu.test(target) ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 64 * 1024 * 1024) {
    throw new AppError("PERMISSION_DENIED", "Native Windows deletion requires a bounded local drive path.");
  }
  const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const request = Buffer.from(JSON.stringify({ target, hash: expectedSha256, limit }), "utf8").toString("base64");
  const code = await new Promise<number | undefined>((resolve) => {
    execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_DELETE_SCRIPT], {
      windowsHide: true, timeout: 25_000, maxBuffer: 4096,
      env: { ...process.env, MCP_HANDLE_DELETE_REQUEST: request },
    }, (error) => resolve(error === null ? 0 : typeof error.code === "number" ? error.code : undefined));
  });
  if (code === 10) throw new AppError("INVALID_ARGUMENT", "Windows deletion target identity or expected SHA-256 differs.");
  if (code === 11) throw new AppError("PERMISSION_DENIED", "Windows refused the pinned handle or file disposition.");
  if (code === 12) throw new AppError("FILE_TOO_LARGE", "File exceeds the workspace deletion-size limit.");
  if (code !== 0) throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Native Windows deletion did not report a verified outcome; inspect the exact path before retrying.");
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Windows deletion is pending or its path was replaced; inspect before retrying.");
}
