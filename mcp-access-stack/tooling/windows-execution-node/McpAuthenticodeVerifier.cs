using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public sealed class McpAuthenticodeVerificationResult
{
    public uint StatusCode { get; private set; }
    public string SignerThumbprint { get; private set; }

    public McpAuthenticodeVerificationResult(uint statusCode, string signerThumbprint)
    {
        StatusCode = statusCode;
        SignerThumbprint = signerThumbprint;
    }
}

public static class McpAuthenticodeVerifier
{
    private const uint WTD_UI_NONE = 2;
    private const uint WTD_REVOKE_NONE = 0;
    private const uint WTD_CHOICE_FILE = 1;
    private const uint WTD_STATEACTION_VERIFY = 1;
    private const uint WTD_STATEACTION_CLOSE = 2;
    private const uint WTD_REVOCATION_CHECK_NONE = 0x00000010;
    private const uint WTD_CACHE_ONLY_URL_RETRIEVAL = 0x00001000;
    private static readonly Guid WinTrustActionGenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        public IntPtr pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CRYPT_PROVIDER_CERT_PREFIX
    {
        public uint cbStruct;
        public IntPtr pCert;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CERT_CONTEXT
    {
        public uint dwCertEncodingType;
        public IntPtr pbCertEncoded;
        public uint cbCertEncoded;
        public IntPtr pCertInfo;
        public IntPtr hCertStore;
    }

    [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int WinVerifyTrust(
        IntPtr hwnd,
        [In] ref Guid pgActionID,
        [In, Out] ref WINTRUST_DATA pWVTData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr hStateData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(
        IntPtr pProvData,
        uint idxSigner,
        [MarshalAs(UnmanagedType.Bool)] bool fCounterSigner,
        uint idxCounterSigner);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr pSgnr, uint idxCert);

    public static McpAuthenticodeVerificationResult Verify(string path)
    {
        if (String.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("Authenticode path is required.", "path");
        }

        string resolvedPath = Path.GetFullPath(path);
        if (!File.Exists(resolvedPath))
        {
            throw new FileNotFoundException("Authenticode target was not found.", resolvedPath);
        }

        IntPtr pathPointer = IntPtr.Zero;
        IntPtr fileInfoPointer = IntPtr.Zero;
        WINTRUST_DATA trustData = new WINTRUST_DATA();
        Guid action = WinTrustActionGenericVerifyV2;

        try
        {
            pathPointer = Marshal.StringToCoTaskMemUni(resolvedPath);
            WINTRUST_FILE_INFO fileInfo = new WINTRUST_FILE_INFO();
            fileInfo.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
            fileInfo.pcwszFilePath = pathPointer;
            fileInfo.hFile = IntPtr.Zero;
            fileInfo.pgKnownSubject = IntPtr.Zero;

            fileInfoPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);

            trustData.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
            trustData.pPolicyCallbackData = IntPtr.Zero;
            trustData.pSIPClientData = IntPtr.Zero;
            trustData.dwUIChoice = WTD_UI_NONE;
            trustData.fdwRevocationChecks = WTD_REVOKE_NONE;
            trustData.dwUnionChoice = WTD_CHOICE_FILE;
            trustData.pFile = fileInfoPointer;
            trustData.dwStateAction = WTD_STATEACTION_VERIFY;
            trustData.hWVTStateData = IntPtr.Zero;
            trustData.pwszURLReference = IntPtr.Zero;
            trustData.dwProvFlags = WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL;
            trustData.dwUIContext = 0;
            trustData.pSignatureSettings = IntPtr.Zero;

            int status = WinVerifyTrust(new IntPtr(-1), ref action, ref trustData);
            string signerThumbprint = GetSignerThumbprint(trustData.hWVTStateData);
            return new McpAuthenticodeVerificationResult(unchecked((uint)status), signerThumbprint);
        }
        finally
        {
            if (trustData.hWVTStateData != IntPtr.Zero)
            {
                trustData.dwStateAction = WTD_STATEACTION_CLOSE;
                WinVerifyTrust(new IntPtr(-1), ref action, ref trustData);
            }
            if (fileInfoPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(fileInfoPointer);
            }
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }
        }
    }

    private static string GetSignerThumbprint(IntPtr stateData)
    {
        if (stateData == IntPtr.Zero)
        {
            return null;
        }

        IntPtr providerData = WTHelperProvDataFromStateData(stateData);
        if (providerData == IntPtr.Zero)
        {
            return null;
        }

        IntPtr signer = WTHelperGetProvSignerFromChain(providerData, 0, false, 0);
        if (signer == IntPtr.Zero)
        {
            return null;
        }

        IntPtr providerCertificate = WTHelperGetProvCertFromChain(signer, 0);
        if (providerCertificate == IntPtr.Zero)
        {
            return null;
        }

        CRYPT_PROVIDER_CERT_PREFIX certificatePrefix =
            (CRYPT_PROVIDER_CERT_PREFIX)Marshal.PtrToStructure(providerCertificate, typeof(CRYPT_PROVIDER_CERT_PREFIX));
        if (certificatePrefix.pCert == IntPtr.Zero)
        {
            return null;
        }

        CERT_CONTEXT certificateContext =
            (CERT_CONTEXT)Marshal.PtrToStructure(certificatePrefix.pCert, typeof(CERT_CONTEXT));
        if (certificateContext.pbCertEncoded == IntPtr.Zero || certificateContext.cbCertEncoded == 0 ||
            certificateContext.cbCertEncoded > Int32.MaxValue)
        {
            return null;
        }

        byte[] encoded = new byte[(int)certificateContext.cbCertEncoded];
        Marshal.Copy(certificateContext.pbCertEncoded, encoded, 0, encoded.Length);
        using (X509Certificate2 certificate = new X509Certificate2(encoded))
        {
            return certificate.Thumbprint;
        }
    }
}