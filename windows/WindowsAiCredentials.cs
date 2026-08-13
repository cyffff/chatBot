using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace GroupRelay.Windows;

internal static class WindowsAiCredentials
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    /// opencode 没有单一 API Key(只能 opencode auth login),所以它不进凭据管理器 ——
    /// 调用方先问这个,别直接 Read:Read 会对不支持的 provider 抛异常。
    public static bool SupportsApiKey(string provider) => provider is "codex" or "claude" or "cursor";

    public static bool IsConfigured(string provider) => SupportsApiKey(provider) && Read(provider) is not null;

    public static string? Read(string provider)
    {
        ValidateProvider(provider);
        if (!CredRead(Target(provider), CredTypeGeneric, 0, out var pointer))
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
            var value = Encoding.Unicode.GetString(bytes).TrimEnd('\0').Trim();
            return value.Length == 0 ? null : value;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Save(string provider, string rawValue)
    {
        ValidateProvider(provider);
        var apiKey = rawValue.Trim();
        var bytes = Encoding.Unicode.GetBytes(apiKey);
        if (apiKey.Length == 0 || bytes.Length > 2048) throw new InvalidDataException("API Key 不能为空或过长");
        var blob = Marshal.AllocCoTaskMem(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = Target(provider),
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = provider
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeCoTaskMem(blob);
        }
    }

    public static void Delete(string provider)
    {
        ValidateProvider(provider);
        if (!CredDelete(Target(provider), CredTypeGeneric, 0) && Marshal.GetLastWin32Error() != ErrorNotFound)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static string Target(string provider) => $"GroupRelay/AI/{provider}";

    private static void ValidateProvider(string provider)
    {
        // opencode 不在这里:它没有单一 API Key,只能用 opencode auth login,凭据由它自己保管。
        if (provider is not ("codex" or "claude" or "cursor")) throw new InvalidDataException("不支持的 AI 类型");
    }

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
