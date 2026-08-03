import AppKit
import ServiceManagement
import WebKit

private let serverPreferenceKey = "GroupRelayServerURL"
private extension Notification.Name {
    static let groupRelayWorkersChanged = Notification.Name("GroupRelayWorkersChanged")
}

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
            let action = body["action"] as? String,
            message.frameInfo.request.url?.host == serverURL.host
        else { return }
        do {
            switch action {
            case "openExternal":
                guard
                    let rawURL = body["url"] as? String,
                    let url = URL(string: rawURL),
                    ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                    url.host == serverURL.host,
                    url.path.hasPrefix("/transfer/")
                else { return }
                if let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
                    NSWorkspace.shared.open(
                        [url],
                        withApplicationAt: chrome,
                        configuration: NSWorkspace.OpenConfiguration()
                    )
                } else {
                    NSWorkspace.shared.open(url)
                }
            case "configureAIWorker":
                guard let worker = body["worker"] as? [String: Any] else { return }
                try configureAIWorker(worker)
            case "removeAIWorker":
                guard let workerId = body["workerId"] as? String else { return }
                try removeAIWorker(workerId)
            default:
                return
            }
        } catch {
            showError("无法更新桌面 AI", detail: error.localizedDescription)
        }
    }

    private var workerRegistryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".group-relay/local-workers.json")
    }

    private func jsonObject(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func writeJSONObject(_ value: [String: Any], to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func configureAIWorker(_ incoming: [String: Any]) throws {
        guard
            let workerId = incoming["workerId"] as? String,
            workerId.range(of: #"^[a-z0-9-]{1,160}$"#, options: .regularExpression) != nil,
            let provider = incoming["provider"] as? String,
            ["codex", "claude", "cursor"].contains(provider),
            let baseUrl = incoming["baseUrl"] as? String,
            let relayURL = URL(string: baseUrl),
            relayURL.host == serverURL.host,
            let groupId = incoming["groupId"] as? String,
            UUID(uuidString: groupId) != nil,
            incoming["memberToken"] as? String != nil
        else {
            throw NSError(
                domain: "GroupRelay",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "桌面 AI 配置无效"]
            )
        }

        var registry = jsonObject(at: workerRegistryURL) ?? ["version": 1, "workers": [String: Any]()]
        var workers = registry["workers"] as? [String: Any] ?? [:]
        var config = incoming
        for value in workers.values {
            guard
                let entry = value as? [String: Any],
                entry["provider"] as? String == provider,
                let configFile = entry["configFile"] as? String,
                let template = jsonObject(at: URL(fileURLWithPath: configFile))
            else { continue }
            for key in ["model", "agentBin", "workspacePath"] where config[key] == nil {
                config[key] = template[key]
            }
            break
        }
        if config["workspacePath"] == nil {
            config["workspacePath"] = FileManager.default.homeDirectoryForCurrentUser.path
        }
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".group-relay/desktop-sessions")
            .appendingPathComponent("\(workerId).json")
        try writeJSONObject(config, to: configURL)
        workers[workerId] = [
            "configFile": configURL.path,
            "groupId": groupId,
            "provider": provider,
            "enabled": true,
            "updatedAt": ISO8601DateFormatter().string(from: Date())
        ]
        registry["version"] = 1
        registry["workers"] = workers
        try writeJSONObject(registry, to: workerRegistryURL)
        NotificationCenter.default.post(name: .groupRelayWorkersChanged, object: nil)
    }

    private func removeAIWorker(_ workerId: String) throws {
        guard workerId.range(of: #"^[a-z0-9-]{1,160}$"#, options: .regularExpression) != nil else {
            throw NSError(
                domain: "GroupRelay",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "桌面 AI 标识无效"]
            )
        }
        var registry = jsonObject(at: workerRegistryURL) ?? ["version": 1, "workers": [String: Any]()]
        var workers = registry["workers"] as? [String: Any] ?? [:]
        if
            let entry = workers.removeValue(forKey: workerId) as? [String: Any],
            let configFile = entry["configFile"] as? String
        {
            try? FileManager.default.removeItem(atPath: configFile)
        }
        registry["version"] = 1
        registry["workers"] = workers
        try writeJSONObject(registry, to: workerRegistryURL)
        NotificationCenter.default.post(name: .groupRelayWorkersChanged, object: nil)
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
        sender.orderOut(nil)
        return true
    }
}

final class LocalAIBridgeManager {
    private var processes: [String: Process] = [:]
    private var timer: Timer?
    private(set) var statusText = "后台 AI：0 个运行中"
    var onStatusChanged: ((String) -> Void)?

    func start() {
        registerLoginItem()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(synchronizeWorkers),
            name: .groupRelayWorkersChanged,
            object: nil
        )
        synchronizeWorkers()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.synchronizeWorkers()
        }
    }

    func stop() {
        NotificationCenter.default.removeObserver(self, name: .groupRelayWorkersChanged, object: nil)
        timer?.invalidate()
        timer = nil
        for process in processes.values where process.isRunning { process.terminate() }
        processes.removeAll()
        updateStatus()
    }

    @objc func synchronizeWorkers() {
        let registryURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".group-relay/local-workers.json")
        guard
            let data = try? Data(contentsOf: registryURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let workers = root["workers"] as? [String: [String: Any]]
        else {
            stopRemovedWorkers(active: [])
            return
        }
        var active = Set<String>()
        for (workerId, worker) in workers {
            guard
                worker["enabled"] as? Bool == true,
                let configFile = worker["configFile"] as? String,
                FileManager.default.fileExists(atPath: configFile)
            else { continue }
            active.insert(workerId)
            if processes[workerId]?.isRunning != true { launch(workerId: workerId, configFile: configFile) }
        }
        stopRemovedWorkers(active: active)
        updateStatus()
    }

    private func launch(workerId: String, configFile: String) {
        guard let helper = Bundle.main.url(forAuxiliaryExecutable: "GroupRelayBridge") else {
            statusText = "后台 AI：桥接程序缺失"
            onStatusChanged?(statusText)
            return
        }
        let process = Process()
        process.executableURL = helper
        process.arguments = ["--config", configFile]
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Group Relay/bridge.log")
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let log = try? FileHandle(forWritingTo: logURL) {
            _ = try? log.seekToEnd()
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] _ in
                try? log.close()
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    self?.processes.removeValue(forKey: workerId)
                    self?.synchronizeWorkers()
                }
            }
        }
        do {
            try process.run()
            processes[workerId] = process
        } catch {
            statusText = "后台 AI 启动失败：\(error.localizedDescription)"
            onStatusChanged?(statusText)
        }
    }

    private func stopRemovedWorkers(active: Set<String>) {
        for workerId in processes.keys.filter({ !active.contains($0) }) {
            guard let process = processes[workerId] else { continue }
            if process.isRunning { process.terminate() }
            processes.removeValue(forKey: workerId)
        }
        updateStatus()
    }

    private func updateStatus() {
        let running = processes.values.filter(\.isRunning).count
        statusText = "后台 AI：\(running) 个运行中"
        onStatusChanged?(statusText)
    }

    private func registerLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .notRegistered { try SMAppService.mainApp.register() }
        } catch {
            statusText = "开机启动未启用：\(error.localizedDescription)"
            onStatusChanged?(statusText)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var relayWindow: RelayWindowController?
    private let bridgeManager = LocalAIBridgeManager()
    private var bridgeStatusItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        relayWindow = RelayWindowController()
        buildMenus()
        bridgeManager.onStatusChanged = { [weak self] status in self?.bridgeStatusItem?.title = status }
        bridgeManager.start()
        relayWindow?.start()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        relayWindow?.start()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridgeManager.stop()
    }

    private func buildMenus() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Group Relay", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let show = appMenu.addItem(withTitle: "显示 Group Relay", action: #selector(showMainWindow), keyEquivalent: "")
        show.target = self
        bridgeStatusItem = appMenu.addItem(withTitle: bridgeManager.statusText, action: #selector(refreshBridges), keyEquivalent: "")
        bridgeStatusItem?.target = self
        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "服务器设置…", action: #selector(RelayWindowController.showServerSettings), keyEquivalent: ",")
        settings.target = relayWindow
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Group Relay", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

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

    @objc private func showMainWindow() {
        relayWindow?.start()
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc private func refreshBridges() {
        bridgeManager.synchronizeWorkers()
    }
}

let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.regular)
application.run()
