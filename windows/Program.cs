using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace GroupRelay.Windows;

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
    private const string DefaultServerUrl = "https://troops-prospects-dictionary-metals.trycloudflare.com";
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly WindowsAiBridgeManager aiBridge = new();
    private readonly NotifyIcon trayIcon = new();
    private string serverUrl;
    private bool exiting;

    public RelayForm()
    {
        serverUrl = SettingsStore.LoadServerUrl() ?? DefaultServerUrl;
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
        aiBridge.Start();
    }

    private MenuStrip BuildMenu()
    {
        var menu = new MenuStrip();
        var app = new ToolStripMenuItem("Group Relay");
        app.DropDownItems.Add("服务器设置…", null, (_, _) => ShowServerSettings());
        app.DropDownItems.Add("在浏览器中打开", null, (_, _) => OpenExternal($"{serverUrl}/app"));
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
            NavigateToClient();
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
        webView.Source = new Uri($"{serverUrl.TrimEnd('/')}/app");
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
        var providers = new[] { "codex", "claude", "cursor" }.Select(provider => new
        {
            provider,
            keyConfigured = WindowsAiCredentials.IsConfigured(provider),
            workerCount = aiBridge.ConfiguredCount(provider)
        });
        return new { platform = "windows", providers };
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

    private void ShowServerSettings()
    {
        using var dialog = new ServerDialog(serverUrl);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        if (!TryNormalizeServerUrl(dialog.ServerUrl, out var normalized))
        {
            MessageBox.Show(
                this,
                "请输入以 http:// 或 https:// 开头的完整服务器地址。",
                "服务器地址无效",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
            return;
        }
        serverUrl = normalized;
        SettingsStore.SaveServerUrl(serverUrl);
        NavigateToClient();
    }

    private static bool TryNormalizeServerUrl(string value, out string normalized)
    {
        normalized = value.Trim().TrimEnd('/');
        return Uri.TryCreate(normalized, UriKind.Absolute, out var uri)
            && uri.Scheme is "http" or "https"
            && !string.IsNullOrWhiteSpace(uri.Host);
    }
}

internal sealed class ServerDialog : Form
{
    private readonly TextBox input = new() { Dock = DockStyle.Top };
    public string ServerUrl => input.Text;

    public ServerDialog(string currentUrl)
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
            Text = "输入 Group Relay 的固定 HTTP/HTTPS 服务根地址：",
            Dock = DockStyle.Top,
            Height = 34
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
