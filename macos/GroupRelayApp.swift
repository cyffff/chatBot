import AppKit
import WebKit

private let serverPreferenceKey = "GroupRelayServerURL"

final class RelayWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private let webView: WKWebView
    private var serverURL: URL

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: configuration)
        serverURL = RelayWindowController.savedServerURL()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Group Relay"
        window.minSize = NSSize(width: 760, height: 560)
        window.center()
        window.contentView = webView
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false

        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        configuration.userContentController.add(self, name: "relayNative")
        webView.customUserAgent = "\(webView.value(forKey: "userAgent") ?? "") GroupRelayMac/1.0"
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func start() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        loadClient()
    }

    private static func savedServerURL() -> URL {
        let defaults = UserDefaults.standard
        let configured = defaults.string(forKey: serverPreferenceKey)
        let bundled = Bundle.main.object(forInfoDictionaryKey: "DefaultRelayURL") as? String
        let value = configured ?? bundled ?? "http://127.0.0.1:8787"
        return normalizedServerURL(value) ?? URL(string: "http://127.0.0.1:8787")!
    }

    private static func normalizedServerURL(_ rawValue: String) -> URL? {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard
            let url = URL(string: value),
            ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.host != nil
        else {
            return nil
        }
        return url
    }

    private func loadClient() {
        let appURL = serverURL.appendingPathComponent("app")
        webView.load(URLRequest(url: appURL, cachePolicy: .reloadRevalidatingCacheData))
    }

    @objc func reloadClient() {
        webView.reload()
    }

    @objc func openInBrowser() {
        NSWorkspace.shared.open(serverURL.appendingPathComponent("app"))
    }

    @objc func showServerSettings() {
        let alert = NSAlert()
        alert.messageText = "Group Relay 服务器"
        alert.informativeText = "输入 Group Relay 的固定 HTTPS 地址。临时 trycloudflare 地址变化后需要在这里更新。"
        alert.addButton(withTitle: "保存并重新连接")
        alert.addButton(withTitle: "取消")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 430, height: 24))
        input.stringValue = serverURL.absoluteString
        input.placeholderString = "https://chat.example.com"
        alert.accessoryView = input
        alert.window.initialFirstResponder = input

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard let url = RelayWindowController.normalizedServerURL(input.stringValue) else {
            showError("服务器地址无效", detail: "请输入以 http:// 或 https:// 开头的完整地址。")
            return
        }
        serverURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: serverPreferenceKey)
        loadClient()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            message.name == "relayNative",
            let body = message.body as? [String: Any],
            body["action"] as? String == "openExternal",
            let rawURL = body["url"] as? String,
            let url = URL(string: rawURL),
            ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.host == serverURL.host,
            url.path.hasPrefix("/transfer/")
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func showError(_ title: String, detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.runModal()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            if url.host == serverURL.host {
                webView.load(navigationAction.request)
            } else {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let safeName = suggestedFilename.replacingOccurrences(of: "/", with: "_")
        var destination = downloads.appendingPathComponent(safeName)
        let extensionName = destination.pathExtension
        let baseName = destination.deletingPathExtension().lastPathComponent
        var counter = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            let nextName = extensionName.isEmpty
                ? "\(baseName)-\(counter)"
                : "\(baseName)-\(counter).\(extensionName)"
            destination = downloads.appendingPathComponent(nextName)
            counter += 1
        }
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        showError("下载失败", detail: error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showError(
            "无法连接 Group Relay",
            detail: "\(error.localizedDescription)\n\n可在“Group Relay → 服务器设置”中修改地址。"
        )
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApplication.shared.terminate(nil)
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var relayWindow: RelayWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        relayWindow = RelayWindowController()
        buildMenus()
        relayWindow?.start()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildMenus() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Group Relay", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "服务器设置…", action: #selector(RelayWindowController.showServerSettings), keyEquivalent: ",")
        settings.target = relayWindow
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Group Relay", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let reload = viewMenu.addItem(withTitle: "重新载入", action: #selector(RelayWindowController.reloadClient), keyEquivalent: "r")
        reload.target = relayWindow
        let browser = viewMenu.addItem(withTitle: "在浏览器中打开", action: #selector(RelayWindowController.openInBrowser), keyEquivalent: "o")
        browser.target = relayWindow
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        NSApplication.shared.mainMenu = mainMenu
    }
}

let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.regular)
application.run()
