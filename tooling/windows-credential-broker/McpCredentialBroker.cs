using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class McpCredentialBrokerProgram
{
    private const int ProtocolVersion = 1;
    private const string Magic = "MCPCRD01";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Dictionary<string, string> values = ParseArguments(args);
            string mode = Require(values, "mode");
            if (String.Equals(mode, "read", StringComparison.OrdinalIgnoreCase))
            {
                return RunRead(values);
            }
            if (String.Equals(mode, "manage", StringComparison.OrdinalIgnoreCase))
            {
                return RunManage(values);
            }
            return 2;
        }
        catch
        {
            return 1;
        }
    }

    private static int RunRead(Dictionary<string, string> values)
    {
        string pipeName = Require(values, "pipe");
        string nonce = Require(values, "nonce");
        string target = RequireCredentialTarget(values);
        int protocol = ParseInt(Require(values, "protocol"), 1, 100);
        int expectedClientProcessId = ParseInt(
            Require(values, "client-pid"),
            1,
            Int32.MaxValue);
        int timeoutMs = values.ContainsKey("timeout-ms")
            ? ParseInt(values["timeout-ms"], 100, 60000)
            : 10000;

        PipeSecurity security = CurrentUserPipeSecurity();
        using (NamedPipeServerStream pipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.Out,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            65536,
            65536,
            security))
        {
            IAsyncResult waiting = pipe.BeginWaitForConnection(null, null);
            if (!waiting.AsyncWaitHandle.WaitOne(timeoutMs))
            {
                return 3;
            }
            pipe.EndWaitForConnection(waiting);

            uint actualClientProcessId;
            if (
                !GetNamedPipeClientProcessId(
                    pipe.SafePipeHandle,
                    out actualClientProcessId) ||
                actualClientProcessId != (uint)expectedClientProcessId
            )
            {
                WriteResponse(pipe, CredentialBrokerStatus.AccessDenied, nonce, null, null);
                return 6;
            }

            if (protocol != ProtocolVersion)
            {
                WriteResponse(pipe, CredentialBrokerStatus.ProtocolMismatch, nonce, null, null);
                return 4;
            }

            CredentialSecret secret = null;
            try
            {
                secret = WindowsCredentialStore.Read(target);
                if (secret == null)
                {
                    WriteResponse(pipe, CredentialBrokerStatus.Unavailable, nonce, null, null);
                    return 5;
                }
                WriteResponse(pipe, CredentialBrokerStatus.Success, nonce, secret.UserNameBytes, secret.PasswordBytes);
                return 0;
            }
            catch (UnauthorizedAccessException)
            {
                WriteResponse(pipe, CredentialBrokerStatus.AccessDenied, nonce, null, null);
                return 6;
            }
            catch
            {
                WriteResponse(pipe, CredentialBrokerStatus.InternalError, nonce, null, null);
                return 7;
            }
            finally
            {
                if (secret != null)
                {
                    secret.Dispose();
                }
            }
        }
    }

    private static int RunManage(Dictionary<string, string> values)
    {
        string target = RequireCredentialTarget(values);
        string site = values.ContainsKey("site") ? values["site"] : "Private site";
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (CredentialManagementForm form = new CredentialManagementForm(target, site))
        {
            Application.Run(form);
            return form.ExitCode;
        }
    }

    private static void WriteResponse(
        Stream stream,
        CredentialBrokerStatus status,
        string nonce,
        byte[] userName,
        byte[] password)
    {
        byte[] magic = Encoding.ASCII.GetBytes(Magic);
        byte[] nonceBytes = Encoding.UTF8.GetBytes(nonce);
        byte[] safeUserName = userName ?? new byte[0];
        byte[] safePassword = password ?? new byte[0];
        using (BinaryWriter writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(magic);
            writer.Write(ProtocolVersion);
            writer.Write((int)status);
            writer.Write(Process.GetCurrentProcess().Id);
            WriteBuffer(writer, nonceBytes, 4096);
            WriteBuffer(writer, safeUserName, 65536);
            WriteBuffer(writer, safePassword, 65536);
            writer.Flush();
        }
        Array.Clear(nonceBytes, 0, nonceBytes.Length);
    }

    private static void WriteBuffer(BinaryWriter writer, byte[] value, int maximum)
    {
        if (value.Length > maximum)
        {
            throw new InvalidDataException("Credential broker payload exceeds its protocol limit.");
        }
        writer.Write(value.Length);
        writer.Write(value);
    }

    private static PipeSecurity CurrentUserPipeSecurity()
    {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        SecurityIdentifier sid = identity.User;
        if (sid == null)
        {
            throw new UnauthorizedAccessException("Current Windows identity has no SID.");
        }
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(
            sid,
            PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
            AccessControlType.Allow));
        return security;
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length || !args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Invalid credential broker argument sequence.");
            }
            values[args[index].Substring(2)] = args[index + 1];
        }
        return values;
    }

    private static string Require(Dictionary<string, string> values, string name)
    {
        string value;
        if (!values.TryGetValue(name, out value) || String.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Missing required credential broker argument.");
        }
        return value;
    }

    private static string RequireCredentialTarget(
        Dictionary<string, string> values)
    {
        string target = Require(values, "target");
        if (!Regex.IsMatch(
            target,
            @"^McpAccessStack/[a-f0-9]{24}/[a-z0-9._-]{1,128}/[a-z0-9._-]{1,128}$",
            RegexOptions.CultureInvariant))
        {
            throw new UnauthorizedAccessException("Credential target is outside the MCP namespace.");
        }
        return target;
    }

    private static int ParseInt(string value, int minimum, int maximum)
    {
        int parsed;
        if (!Int32.TryParse(value, out parsed) || parsed < minimum || parsed > maximum)
        {
            throw new ArgumentException("Invalid credential broker numeric argument.");
        }
        return parsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(
        SafePipeHandle pipe,
        out uint clientProcessId);

    private enum CredentialBrokerStatus
    {
        Success = 0,
        Unavailable = 1,
        AccessDenied = 2,
        ProtocolMismatch = 3,
        InternalError = 4
    }
}

internal sealed class CredentialSecret : IDisposable
{
    public byte[] UserNameBytes { get; private set; }
    public byte[] PasswordBytes { get; private set; }

    public CredentialSecret(byte[] userNameBytes, byte[] passwordBytes)
    {
        UserNameBytes = userNameBytes;
        PasswordBytes = passwordBytes;
    }

    public void Dispose()
    {
        if (UserNameBytes != null)
        {
            Array.Clear(UserNameBytes, 0, UserNameBytes.Length);
            UserNameBytes = null;
        }
        if (PasswordBytes != null)
        {
            Array.Clear(PasswordBytes, 0, PasswordBytes.Length);
            PasswordBytes = null;
        }
    }
}

internal static class WindowsCredentialStore
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;
    private const int ErrorAccessDenied = 5;

    public static CredentialSecret Read(string target)
    {
        IntPtr credentialPointer;
        if (!CredRead(target, CredTypeGeneric, 0, out credentialPointer))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound)
            {
                return null;
            }
            if (error == ErrorAccessDenied)
            {
                throw new UnauthorizedAccessException();
            }
            throw new System.ComponentModel.Win32Exception(error);
        }

        try
        {
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(
                credentialPointer,
                typeof(NativeCredential));
            string userName = credential.UserName == IntPtr.Zero
                ? String.Empty
                : Marshal.PtrToStringUni(credential.UserName) ?? String.Empty;
            byte[] passwordUnicode = new byte[credential.CredentialBlobSize];
            if (credential.CredentialBlobSize > 0 && credential.CredentialBlob != IntPtr.Zero)
            {
                Marshal.Copy(credential.CredentialBlob, passwordUnicode, 0, passwordUnicode.Length);
            }
            byte[] userNameUtf8 = Encoding.UTF8.GetBytes(userName);
            byte[] passwordUtf8 = Encoding.Convert(
                Encoding.Unicode,
                Encoding.UTF8,
                passwordUnicode);
            Array.Clear(passwordUnicode, 0, passwordUnicode.Length);
            return new CredentialSecret(userNameUtf8, passwordUtf8);
        }
        finally
        {
            CredFree(credentialPointer);
        }
    }

    public static void Write(string target, string userName, string password)
    {
        byte[] passwordBytes = Encoding.Unicode.GetBytes(password ?? String.Empty);
        if (passwordBytes.Length > 5120)
        {
            Array.Clear(passwordBytes, 0, passwordBytes.Length);
            throw new ArgumentException("Password exceeds the Windows Credential Manager limit.");
        }
        IntPtr blob = IntPtr.Zero;
        try
        {
            blob = Marshal.AllocCoTaskMem(passwordBytes.Length == 0 ? 2 : passwordBytes.Length);
            if (passwordBytes.Length > 0)
            {
                Marshal.Copy(passwordBytes, 0, blob, passwordBytes.Length);
            }
            else
            {
                Marshal.WriteInt16(blob, 0);
            }
            NativeCredential credential = new NativeCredential();
            credential.Type = CredTypeGeneric;
            credential.TargetName = Marshal.StringToCoTaskMemUni(target);
            credential.UserName = Marshal.StringToCoTaskMemUni(userName ?? String.Empty);
            credential.CredentialBlobSize = (uint)passwordBytes.Length;
            credential.CredentialBlob = blob;
            credential.Persist = CredPersistLocalMachine;
            try
            {
                if (!CredWrite(ref credential, 0))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                if (credential.TargetName != IntPtr.Zero)
                {
                    Marshal.ZeroFreeCoTaskMemUnicode(credential.TargetName);
                }
                if (credential.UserName != IntPtr.Zero)
                {
                    Marshal.ZeroFreeCoTaskMemUnicode(credential.UserName);
                }
            }
        }
        finally
        {
            Array.Clear(passwordBytes, 0, passwordBytes.Length);
            if (blob != IntPtr.Zero)
            {
                for (int index = 0; index < Math.Max(2, passwordBytes.Length); index++)
                {
                    Marshal.WriteByte(blob, index, 0);
                }
                Marshal.FreeCoTaskMem(blob);
            }
        }
    }

    public static void Delete(string target)
    {
        if (CredDelete(target, CredTypeGeneric, 0))
        {
            return;
        }
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorNotFound)
        {
            throw new System.ComponentModel.Win32Exception(error);
        }
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref NativeCredential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr credential);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }
}

internal sealed class CredentialManagementForm : Form
{
    private readonly string target;
    private readonly TextBox userNameBox;
    private readonly TextBox passwordBox;
    private readonly Label statusLabel;

    public int ExitCode { get; private set; }

    public CredentialManagementForm(string targetValue, string site)
    {
        target = targetValue;
        ExitCode = 0;
        Text = "MCP Credential Broker";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 250);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        Label title = new Label();
        title.Text = "Credentials for " + site;
        title.Location = new Point(20, 18);
        title.Size = new Size(400, 24);
        title.Font = new Font(Font, FontStyle.Bold);

        Label userLabel = new Label();
        userLabel.Text = "Username";
        userLabel.Location = new Point(20, 62);
        userLabel.Size = new Size(100, 20);
        userNameBox = new TextBox();
        userNameBox.Location = new Point(130, 60);
        userNameBox.Size = new Size(280, 24);

        Label passwordLabel = new Label();
        passwordLabel.Text = "Password";
        passwordLabel.Location = new Point(20, 102);
        passwordLabel.Size = new Size(100, 20);
        passwordBox = new TextBox();
        passwordBox.Location = new Point(130, 100);
        passwordBox.Size = new Size(280, 24);
        passwordBox.UseSystemPasswordChar = true;

        Button save = new Button();
        save.Text = "Save";
        save.Location = new Point(130, 148);
        save.Size = new Size(85, 30);
        save.Click += SaveClick;

        Button delete = new Button();
        delete.Text = "Delete";
        delete.Location = new Point(225, 148);
        delete.Size = new Size(85, 30);
        delete.Click += DeleteClick;

        Button close = new Button();
        close.Text = "Close";
        close.Location = new Point(325, 148);
        close.Size = new Size(85, 30);
        close.Click += delegate { Close(); };

        statusLabel = new Label();
        statusLabel.Location = new Point(20, 198);
        statusLabel.Size = new Size(390, 32);

        Controls.Add(title);
        Controls.Add(userLabel);
        Controls.Add(userNameBox);
        Controls.Add(passwordLabel);
        Controls.Add(passwordBox);
        Controls.Add(save);
        Controls.Add(delete);
        Controls.Add(close);
        Controls.Add(statusLabel);

        Load += FormLoad;
    }

    private void FormLoad(object sender, EventArgs args)
    {
        CredentialSecret existing = null;
        try
        {
            existing = WindowsCredentialStore.Read(target);
            if (existing != null)
            {
                userNameBox.Text = Encoding.UTF8.GetString(existing.UserNameBytes);
                statusLabel.Text = "A credential is already stored. Enter the password to replace it.";
            }
        }
        catch
        {
            statusLabel.Text = "Unable to inspect the existing credential.";
        }
        finally
        {
            if (existing != null)
            {
                existing.Dispose();
            }
        }
    }

    private void SaveClick(object sender, EventArgs args)
    {
        try
        {
            if (String.IsNullOrWhiteSpace(userNameBox.Text) || passwordBox.Text.Length == 0)
            {
                statusLabel.Text = "Username and password are required.";
                return;
            }
            WindowsCredentialStore.Write(target, userNameBox.Text, passwordBox.Text);
            passwordBox.Clear();
            statusLabel.Text = "Credential stored in Windows Credential Manager.";
        }
        catch
        {
            ExitCode = 1;
            statusLabel.Text = "Credential storage failed.";
        }
    }

    private void DeleteClick(object sender, EventArgs args)
    {
        try
        {
            WindowsCredentialStore.Delete(target);
            userNameBox.Clear();
            passwordBox.Clear();
            statusLabel.Text = "Credential removed.";
        }
        catch
        {
            ExitCode = 1;
            statusLabel.Text = "Credential removal failed.";
        }
    }
}
