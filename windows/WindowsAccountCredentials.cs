using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GroupRelay.Windows;

internal static class WindowsAccountCredentials
{
    private const string TargetName = "GroupRelay/Account/current";
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    public static (string Email, string AccountToken)? Read()
    {
        if (!CredRead(TargetName, CredTypeGeneric, 0, out var pointer))
        {
            if (Marshal.GetLastWin32Error() == ErrorNotFound) return null;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            var value = JsonSerializer.Deserialize<AccountCredential>(Encoding.Unicode.GetString(bytes).TrimEnd('\0'));
            return value is null ? null : (value.Email, value.AccountToken);
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Save(string email, string accountToken)
    {
        var normalizedEmail = email.Trim().ToLowerInvariant();
        var token = accountToken.Trim();
        if (!normalizedEmail.Contains('@') || normalizedEmail.Length > 254 || token.Length is 0 or > 10_000)
            throw new InvalidDataException("账户凭证无效");
        var bytes = Encoding.Unicode.GetBytes(JsonSerializer.Serialize(new AccountCredential(normalizedEmail, token)));
        var blob = Marshal.AllocCoTaskMem(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = TargetName,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = normalizedEmail
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeCoTaskMem(blob);
        }
    }

    public static void Delete()
    {
        if (!CredDelete(TargetName, CredTypeGeneric, 0) && Marshal.GetLastWin32Error() != ErrorNotFound)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private sealed record AccountCredential(string Email, string AccountToken);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
}
