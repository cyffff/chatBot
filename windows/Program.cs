using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace GroupRelay.Windows;

/// 打包时注入的默认服务器地址:`dotnet publish -p:GroupRelayDefaultUrl=https://chat.example.com`。
/// 仓库里不设值,所以从源码编译出来的产物不会带着别人的、还会过期的临时隧道地址。
internal static class BuildDefaults
{
    public static string? ServerUrl => typeof(BuildDefaults).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(attribute => attribute.Key == "GroupRelayDefaultUrl")?
        .Value;
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new RelayForm());
    }
}

internal sealed class RelayForm : Form
{
    /// 编译产物里不烧死地址:临时隧道会过期,别人编译出来默认就连不上(反馈工单 e03fe6ed)。
    /// 要给自己团队打包,构建时传 GROUP_RELAY_DEFAULT_URL;不传则首启直接问用户。
    private static readonly string? DefaultServerUrl =
        string.IsNullOrWhiteSpace(BuildDefaults.ServerUrl) ? null : BuildDefaults.ServerUrl;
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly WindowsAiBridgeManager aiBridge = new();
    private readonly NotifyIcon trayIcon = new();
    private string serverUrl;
    private bool exiting;

    public RelayForm()
    {
        serverUrl = SettingsStore.LoadServerUrl() ?? DefaultServerUrl ?? "";
        Text = "Group Relay";
        Width = 1180;
        Height = 820;
        MinimumSize = new Size(760, 560);
        StartPosition = FormStartPosition.CenterScreen;
        trayIcon.Icon = SystemIcons.Application;
        trayIcon.Text = "Group Relay";
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (_, _) => RestoreWindow();
        trayIcon.ContextMenuStrip = new ContextMenuStrip();
        trayIcon.ContextMenuStrip.Items.Add("显示 Group Relay", null, (_, _) => RestoreWindow());
        trayIcon.ContextMenuStrip.Items.Add("退出", null, (_, _) => ExitApplication());

        var menu = BuildMenu();
        MainMenuStrip = menu;
        Controls.Add(webView);
        Controls.Add(menu);
        Load += async (_, _) => await InitializeWebView();
        Resize += (_, _) => { if (WindowState == FormWindowState.Minimized) Hide(); };
        FormClosing += (_, eventArgs) =>
        {
            if (exiting) return;
            eventArgs.Cancel = true;
            Hide();
            trayIcon.ShowBalloonTip(1500, "Group Relay", "窗口已隐藏，桌面 AI 仍在后台运行。", ToolTipIcon.Info);
        };
        aiBridge.Start(() => serverUrl);
    }

    private MenuStrip BuildMenu()
    {
        var menu = new MenuStrip();
        var app = new ToolStripMenuItem("Group Relay");
        app.DropDownItems.Add("服务器设置…", null, (_, _) => ShowServerSettings());
        app.DropDownItems.Add("在浏览器中打开", null, async (_, _) => await OpenAccountInBrowser());
        app.DropDownItems.Add(new ToolStripSeparator());
        app.DropDownItems.Add("退出", null, (_, _) => ExitApplication());

        var view = new ToolStripMenuItem("显示");
        view.DropDownItems.Add("重新载入", null, (_, _) => webView.Reload());

        menu.Items.Add(app);
        menu.Items.Add(view);
        return menu;
    }

    private async Task InitializeWebView()
    {
        try
        {
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "GroupRelay",
                "WebView2"
            );
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDir);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
            webView.CoreWebView2.Settings.UserAgent =
                $"{webView.CoreWebView2.Settings.UserAgent} GroupRelayWindows/1.0";
            webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
            webView.CoreWebView2.NewWindowRequested += (_, eventArgs) =>
            {
                eventArgs.Handled = true;
                OpenExternal(eventArgs.Uri);
            };
            webView.CoreWebView2.NavigationCompleted += (_, eventArgs) =>
            {
                if (eventArgs.IsSuccess) return;
                BeginInvoke(new Action(() => HandleNavigationFailed(eventArgs.WebErrorStatus)));
            };
            webView.CoreWebView2.ProcessFailed += (_, eventArgs) =>
            {
                BeginInvoke((Action)(() => MessageBox.Show(
                    this,
                    $"浏览器组件异常：{eventArgs.ProcessFailedKind}",
                    "Group Relay",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                )));
            };
            if (string.IsNullOrWhiteSpace(serverUrl))
            {
                ShowServerSettings(firstRun: true);
            }
            else
            {
                NavigateToClient();
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                $"无法启动 WebView2：{error.Message}\n\n请安装或更新 Microsoft Edge WebView2 Runtime。",
                "Group Relay",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private void NavigateToClient()
    {
        if (string.IsNullOrWhiteSpace(serverUrl))
        {
            ShowServerSettings(firstRun: true);
            return;
        }
        webView.Source = new Uri($"{serverUrl.TrimEnd('/')}/app");
    }

    /// 连不上最常见的原因就是地址过期(临时隧道会变)。别静默停在白页,直接问要不要改地址。
    private void HandleNavigationFailed(CoreWebView2WebErrorStatus status)
    {
        var answer = MessageBox.Show(
            this,
            $"连不上 Group Relay。\n当前地址：{serverUrl}\n原因：{status}\n\n"
            + "如果这是一个临时隧道地址，它很可能已经过期，向群主要一个新的。要现在修改吗？",
            "Group Relay",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning
        );
        if (answer == DialogResult.Yes) ShowServerSettings(firstRun: false);
    }

    private void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        string? requestId = null;
        try
        {
            using var document = JsonDocument.Parse(eventArgs.WebMessageAsJson);
            var root = document.RootElement;
            requestId = root.TryGetProperty("requestId", out var request) ? request.GetString() : null;
            var server = new Uri(serverUrl);
            if (!Uri.TryCreate(eventArgs.Source, UriKind.Absolute, out var source)) return;
            if (!string.Equals(source.Host, server.Host, StringComparison.OrdinalIgnoreCase)) return;
            switch (root.GetProperty("action").GetString())
            {
                case "openExternal":
                    var rawUrl = root.GetProperty("url").GetString();
                    if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var url)) return;
                    if (url.Scheme is not ("http" or "https")) return;
                    if (!string.Equals(url.Host, server.Host, StringComparison.OrdinalIgnoreCase)) return;
                    if (!url.AbsolutePath.StartsWith("/transfer/", StringComparison.Ordinal)) return;
                    OpenExternal(url.AbsoluteUri);
                    break;
                case "configureAIWorker":
                    aiBridge.Configure(root.GetProperty("worker"));
                    break;
                case "removeAIWorker":
                    aiBridge.Remove(root.GetProperty("workerId").GetString() ?? "");
                    break;
                case "getAISettings":
                    if (requestId is not null) SendNativeResponse(requestId, AiSettingsPayload());
                    break;
                case "saveAIKey":
                    if (requestId is null) return;
                    WindowsAiCredentials.Save(
                        root.GetProperty("provider").GetString() ?? "",
                        root.GetProperty("apiKey").GetString() ?? ""
                    );
                    SendNativeResponse(requestId, AiSettingsPayload());
                    break;
                case "deleteAIKey":
                    if (requestId is null) return;
                    WindowsAiCredentials.Delete(root.GetProperty("provider").GetString() ?? "");
                    SendNativeResponse(requestId, AiSettingsPayload());
                    break;
                case "getAccountCredential":
                    if (requestId is null) return;
                    var credential = WindowsAccountCredentials.Read();
                    SendNativeResponse(requestId, credential is null
                        ? new { }
                        : new { email = credential });
                    break;
                case "saveAccountCredential":
                    if (requestId is null) return;
                    WindowsAccountCredentials.Save(root.GetProperty("email").GetString() ?? "");
                    SendNativeResponse(requestId, new { saved = true });
                    break;
                case "deleteAccountCredential":
                    if (requestId is null) return;
                    WindowsAccountCredentials.Delete();
                    SendNativeResponse(requestId, new { deleted = true });
                    break;
            }
        }
        catch (Exception error)
        {
            if (requestId is not null) SendNativeResponse(requestId, error: error.Message);
            else MessageBox.Show(this, error.Message, "无法更新桌面 AI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private object AiSettingsPayload()
    {
        var providers = new[] { "codex", "claude", "cursor", "opencode" }.Select(provider =>
        {
            var cliPath = FindCliPath(provider);
            return new
            {
                provider,
                keyConfigured = WindowsAiCredentials.IsConfigured(provider),
                credentialStore = WindowsAiCredentials.SupportsApiKey(provider)
                    ? "Windows Credential Manager"
                    : "opencode 自己的登录",
                cliAvailable = cliPath is not null,
                cliPath = cliPath ?? "",
                workerCount = aiBridge.ConfiguredCount(provider)
            };
        });
        return new { platform = "windows", providers };
    }

    private static string? FindCliPath(string provider)
    {
        var names = provider switch
        {
            "codex" => new[] { "codex.exe" },
            "claude" => new[] { "claude.exe" },
            "cursor" => new[] { "cursor-agent.exe" },
            "opencode" => new[] { "opencode.exe", "opencode.cmd" },
            _ => Array.Empty<string>()
        };
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = names.SelectMany(name => new[]
        {
            Path.Combine(home, ".local", "bin", name),
            Path.Combine(home, ".cursor", "bin", name),
            Path.Combine(local, "Programs", "cursor-agent", name)
        }).Concat((Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .SelectMany(directory => names.Select(name => Path.Combine(directory.Trim('"'), name))));
        return candidates.FirstOrDefault(File.Exists);
    }

    private void SendNativeResponse(string requestId, object? result = null, string? error = null)
    {
        var payload = JsonSerializer.Serialize(new
        {
            type = "relayNativeResponse",
            requestId,
            ok = error is null,
            result,
            error
        });
        webView.CoreWebView2.PostWebMessageAsJson(payload);
    }

    private void RestoreWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        exiting = true;
        aiBridge.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        Application.Exit();
    }

    private static void OpenExternal(string url)
    {
        var chrome = FindChrome();
        if (chrome is not null)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = chrome,
                Arguments = $"\"{url}\"",
                UseShellExecute = true
            });
            return;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private async Task OpenAccountInBrowser()
    {
        var credential = WindowsAccountCredentials.Read();
        if (credential is null)
        {
            MessageBox.Show(
                this,
                "请先在 Group Relay 客户端完成邮箱账户登录。",
                "还没有可同步的账户",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            return;
        }
        try
        {
            using var client = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{serverUrl.TrimEnd('/')}/api/account/web-logins");
            request.Headers.Add("X-Relay-Email", credential);
            request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var loginUrl = document.RootElement.GetProperty("loginUrl").GetString();
            if (!Uri.TryCreate(loginUrl, UriKind.Absolute, out var url)
                || !string.Equals(url.Host, new Uri(serverUrl).Host, StringComparison.OrdinalIgnoreCase)
                || !url.AbsolutePath.StartsWith("/web-login/", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("服务器返回了无效的网页登录链接");
            }
            OpenExternal(url.AbsoluteUri);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                $"无法创建一次性网页登录链接：{error.Message}",
                "网页同步失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
        }
    }

    private static string? FindChrome()
    {
        var registryPaths = new[]
        {
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
            @"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        };
        foreach (var path in registryPaths)
        {
            if (Registry.GetValue(path, "", null) is string value && File.Exists(value)) return value;
        }

        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private void ShowServerSettings() => ShowServerSettings(firstRun: false);

    private void ShowServerSettings(bool firstRun)
    {
        using var dialog = new ServerDialog(firstRun ? "" : serverUrl, firstRun);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            if (firstRun)
            {
                MessageBox.Show(
                    this,
                    "还没有服务器地址，暂时连不上。随时可以从菜单「服务器设置…」再填。",
                    "Group Relay",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            return;
        }
        if (!TryNormalizeServerUrl(dialog.ServerUrl, out var normalized))
        {
            MessageBox.Show(
                this,
                "请输入以 http:// 或 https:// 开头的完整服务器地址。",
                "服务器地址无效",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
            ShowServerSettings(firstRun);
            return;
        }
        serverUrl = normalized;
        SettingsStore.SaveServerUrl(serverUrl);
        NavigateToClient();
    }

    /// 同事手上通常只有一条群邀请链接,那就让他直接贴:遇到 /join、/group、/app 这类客户端
    /// 路由时只取根地址。真正架在子路径下的部署(反向代理)保持原样,不动它的前缀。
    private static readonly string[] ClientRoutePrefixes = ["/join", "/group", "/app", "/transfer", "/web-login"];

    private static bool TryNormalizeServerUrl(string value, out string normalized)
    {
        normalized = value.Trim().TrimEnd('/');
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.IsNullOrWhiteSpace(uri.Host))
        {
            return false;
        }
        var path = uri.AbsolutePath.TrimEnd('/');
        if (ClientRoutePrefixes.Any(prefix => path == prefix || path.StartsWith($"{prefix}/", StringComparison.Ordinal)))
        {
            normalized = uri.GetLeftPart(UriPartial.Authority);
        }
        return true;
    }
}

internal sealed class ServerDialog : Form
{
    private readonly TextBox input = new() { Dock = DockStyle.Top };
    public string ServerUrl => input.Text;

    public ServerDialog(string currentUrl, bool firstRun = false)
    {
        Text = "Group Relay 服务器";
        Width = 520;
        Height = 180;
        MinimizeBox = false;
        MaximizeBox = false;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;

        var description = new Label
        {
            Text = firstRun
                ? "这个客户端没有内置服务器地址（临时隧道地址会过期，烧进安装包只会让人连不上）。\n"
                    + "贴上你们在用的入口 —— 直接粘群邀请链接也行，会自动取出服务器地址："
                : "输入 Group Relay 的 HTTP/HTTPS 服务根地址：",
            Dock = DockStyle.Top,
            Height = firstRun ? 48 : 34
        };
        input.Text = currentUrl;

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 46,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(8)
        };
        var save = new Button { Text = "保存并连接", DialogResult = DialogResult.OK, AutoSize = true };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, AutoSize = true };
        buttons.Controls.Add(save);
        buttons.Controls.Add(cancel);

        var content = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14) };
        content.Controls.Add(input);
        content.Controls.Add(description);
        Controls.Add(content);
        Controls.Add(buttons);
        AcceptButton = save;
        CancelButton = cancel;
    }
}

internal static class SettingsStore
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "GroupRelay",
        "settings.json"
    );

    public static string? LoadServerUrl()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            using var document = JsonDocument.Parse(File.ReadAllText(FilePath));
            return document.RootElement.GetProperty("serverUrl").GetString();
        }
        catch
        {
            return null;
        }
    }

    public static void SaveServerUrl(string serverUrl)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(new { serverUrl }));
    }
}
