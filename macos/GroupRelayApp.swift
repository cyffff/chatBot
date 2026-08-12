import AppKit
import Darwin
import Security
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
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Group Relay"
        window.minSize = NSSize(width: 760, height: 560)
        window.center()
        window.contentView = webView
        // Keep a native title bar above the WKWebView. A full-size transparent
        // title bar lets the web view consume mouse events in the drag region,
        // which makes the desktop window feel stuck.
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.isMovable = true
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
        guard let credential = accountCredential(), let email = credential["email"] as? String else {
            showError("还没有可同步的账户", detail: "请先在 Group Relay 客户端完成邮箱账户登录。")
            return
        }
        var request = URLRequest(url: serverURL.appendingPathComponent("api/account/web-logins"))
        request.httpMethod = "POST"
        request.setValue(email, forHTTPHeaderField: "X-Relay-Email")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            guard
                error == nil,
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                let data,
                let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let rawURL = value["loginUrl"] as? String,
                let loginURL = URL(string: rawURL),
                loginURL.host == self.serverURL.host,
                loginURL.path.hasPrefix("/web-login/")
            else {
                DispatchQueue.main.async {
                    self.showError(
                        "无法打开已登录网页",
                        detail: error?.localizedDescription ?? "服务器未能创建一次性网页登录链接。"
                    )
                }
                return
            }
            DispatchQueue.main.async { NSWorkspace.shared.open(loginURL) }
        }.resume()
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
        let requestId = body["requestId"] as? String
        do {
            switch action {
            case "setServerUrl":
                // 网页同步完账号数据后要求切服务器:和菜单里的「服务器设置…」走同一条路。
                guard
                    let requestId,
                    let raw = body["serverUrl"] as? String,
                    let url = RelayWindowController.normalizedServerURL(raw)
                else { return }
                serverURL = url
                UserDefaults.standard.set(url.absoluteString, forKey: serverPreferenceKey)
                sendNativeResponse(requestId: requestId, result: ["serverUrl": url.absoluteString])
                loadClient()
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
            case "getAISettings":
                guard let requestId else { return }
                sendNativeResponse(requestId: requestId, result: aiSettingsPayload())
            case "saveAIKey":
                guard
                    let requestId,
                    let provider = body["provider"] as? String,
                    let apiKey = body["apiKey"] as? String
                else { return }
                try saveAPIKey(apiKey, provider: provider)
                sendNativeResponse(requestId: requestId, result: aiSettingsPayload())
            case "deleteAIKey":
                guard let requestId, let provider = body["provider"] as? String else { return }
                try deleteAPIKey(provider: provider)
                sendNativeResponse(requestId: requestId, result: aiSettingsPayload())
            case "getAccountCredential":
                guard let requestId else { return }
                sendNativeResponse(requestId: requestId, result: accountCredential() ?? [:])
            case "saveAccountCredential":
                guard
                    let requestId,
                    let email = body["email"] as? String
                else { return }
                try saveAccountCredential(email: email)
                sendNativeResponse(requestId: requestId, result: ["saved": true])
            case "deleteAccountCredential":
                guard let requestId else { return }
                try? FileManager.default.removeItem(at: accountCredentialURL)
                sendNativeResponse(requestId: requestId, result: ["deleted": true])
            default:
                return
            }
        } catch {
            writeAppLog("Native action \(action) failed: \(error.localizedDescription)")
            if let requestId {
                sendNativeResponse(requestId: requestId, error: error.localizedDescription)
            } else {
                showError("无法更新桌面 AI", detail: error.localizedDescription)
            }
        }
    }

    private var workerRegistryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".group-relay/local-workers.json")
    }

    private var appLogURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Group Relay/app.log")
    }

    private var accountCredentialURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".group-relay/account-credential.json")
    }

    private func accountCredential() -> [String: Any]? {
        guard
            let value = jsonObject(at: accountCredentialURL),
            let email = value["email"] as? String,
            email.contains("@")
        else { return nil }
        return ["email": email]
    }

    /// 身份就是 email,没有 account token 可存。
    private func saveAccountCredential(email: String) throws {
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedEmail.contains("@"), normalizedEmail.utf8.count <= 254 else {
            throw NSError(domain: "GroupRelay", code: 24, userInfo: [NSLocalizedDescriptionKey: "账户凭证无效"])
        }
        try writeJSONObject(["email": normalizedEmail], to: accountCredentialURL)
    }

    private func writeAppLog(_ message: String) {
        let formatter = ISO8601DateFormatter()
        let line = "\(formatter.string(from: Date())) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        do {
            try FileManager.default.createDirectory(
                at: appLogURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            // app.log 同样没有上限,超过 4MB 轮转一份 .1。
            if let size = (try? FileManager.default.attributesOfItem(atPath: appLogURL.path))?[.size] as? Int,
               size > 4 * 1024 * 1024 {
                let rotated = appLogURL.appendingPathExtension("1")
                try? FileManager.default.removeItem(at: rotated)
                try? FileManager.default.moveItem(at: appLogURL, to: rotated)
            }
            if !FileManager.default.fileExists(atPath: appLogURL.path) {
                try data.write(to: appLogURL, options: .atomic)
            } else {
                let handle = try FileHandle(forWritingTo: appLogURL)
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                try handle.close()
            }
        } catch {
            // Logging must never prevent the native action from returning its real error.
        }
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

    private func validateProvider(_ provider: String) throws {
        guard ["codex", "claude", "cursor"].contains(provider) else {
            throw NSError(domain: "GroupRelay", code: 20, userInfo: [NSLocalizedDescriptionKey: "不支持的 AI 类型"])
        }
    }

    private func credentialService(_ provider: String) -> String {
        "com.grouprelay.\(provider)-api"
    }

    private func keychainQuery(_ provider: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: provider,
            kSecAttrService: credentialService(provider)
        ]
    }

    private func hasAPIKey(_ provider: String) -> Bool {
        var query = keychainQuery(provider)
        query[kSecReturnData] = false
        query[kSecMatchLimit] = kSecMatchLimitOne
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    private func keychainError(_ action: String, status: OSStatus) -> NSError {
        let systemMessage = SecCopyErrorMessageString(status, nil) as String? ?? "未知错误"
        return NSError(
            domain: "GroupRelay",
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: "无法\(action) macOS 钥匙串（\(status)：\(systemMessage)）"]
        )
    }

    private func saveAPIKey(_ rawValue: String, provider: String) throws {
        try validateProvider(provider)
        let apiKey = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !apiKey.isEmpty, apiKey.utf8.count <= 10_000 else {
            throw NSError(domain: "GroupRelay", code: 21, userInfo: [NSLocalizedDescriptionKey: "API Key 不能为空或过长"])
        }
        let query = keychainQuery(provider)
        let data = Data(apiKey.utf8)
        let existingStatus = SecItemCopyMatching(query as CFDictionary, nil)
        var status: OSStatus
        if existingStatus == errSecSuccess {
            status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        } else if existingStatus == errSecItemNotFound {
            var value = query
            value[kSecValueData] = data
            value[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
            value[kSecAttrLabel] = "Group Relay \(provider.capitalized) API Key"
            status = SecItemAdd(value as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
            }
        } else {
            throw keychainError("读取", status: existingStatus)
        }
        guard status == errSecSuccess else { throw keychainError("写入", status: status) }
        writeAppLog("Saved \(provider) API Key in macOS Keychain")
    }

    private func deleteAPIKey(provider: String) throws {
        try validateProvider(provider)
        let status = SecItemDelete(keychainQuery(provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError("删除", status: status)
        }
        writeAppLog("Deleted \(provider) API Key from macOS Keychain")
    }

    private func aiSettingsPayload() -> [String: Any] {
        let registry = jsonObject(at: workerRegistryURL)
        let workers = registry?["workers"] as? [String: Any] ?? [:]
        let providers = ["codex", "claude", "cursor"].map { provider -> [String: Any] in
            let count = workers.values.filter { value in
                (value as? [String: Any])?["provider"] as? String == provider
            }.count
            let cliPath = cliExecutablePath(provider)
            return [
                "provider": provider,
                "keyConfigured": hasAPIKey(provider),
                "credentialStore": "macOS 钥匙串",
                "cliAvailable": cliPath != nil,
                "cliPath": cliPath ?? "",
                "workerCount": count
            ]
        }
        return ["platform": "macos", "providers": providers]
    }

    private func cliExecutablePath(_ provider: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let names: [String]
        let preferred: [String]
        switch provider {
        case "codex":
            names = ["codex"]
            preferred = ["/Applications/ChatGPT.app/Contents/Resources/codex", "\(home)/.local/bin/codex"]
        case "claude":
            names = ["claude"]
            preferred = ["\(home)/.local/bin/claude"]
        case "cursor":
            names = ["cursor-agent"]
            preferred = ["\(home)/.local/bin/cursor-agent", "\(home)/.cursor/bin/cursor-agent"]
        default:
            return nil
        }
        let standard = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .flatMap { directory in names.map { "\(directory)/\($0)" } }
        let fromPath = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .flatMap { directory in names.map { "\(directory)/\($0)" } }
        return (preferred + standard + fromPath)
            .first(where: FileManager.default.isExecutableFile(atPath:))
    }

    private func sendNativeResponse(requestId: String, result: [String: Any]? = nil, error: String? = nil) {
        var payload: [String: Any] = [
            "type": "relayNativeResponse",
            "requestId": requestId,
            "ok": error == nil
        ]
        if let result { payload["result"] = result }
        if let error { payload["error"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let encoded = data.base64EncodedString()
        let script = """
        (() => {
          const bytes = Uint8Array.from(atob('\(encoded)'), character => character.charCodeAt(0));
          const detail = JSON.parse(new TextDecoder().decode(bytes));
          window.dispatchEvent(new CustomEvent('relay-native-response', { detail }));
        })();
        """
        DispatchQueue.main.async { [weak self] in self?.webView.evaluateJavaScript(script) }
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
            incoming["email"] as? String != nil
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
    private var remoteSyncInFlight = false
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
        synchronizeRemoteWorkers()
        synchronizeWorkers()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.synchronizeRemoteWorkers()
            self?.synchronizeWorkers()
        }
    }

    func stop() {
        NotificationCenter.default.removeObserver(self, name: .groupRelayWorkersChanged, object: nil)
        timer?.invalidate()
        timer = nil
        for process in processes.values where process.isRunning { terminateProcessTree(process) }
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

    private func synchronizeRemoteWorkers() {
        guard !remoteSyncInFlight else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let credentialURL = home.appendingPathComponent(".group-relay/account-credential.json")
        guard
            let credentialData = try? Data(contentsOf: credentialURL),
            let credential = try? JSONSerialization.jsonObject(with: credentialData) as? [String: Any],
            let email = credential["email"] as? String,
            !email.isEmpty
        else { return }
        let configured = UserDefaults.standard.string(forKey: serverPreferenceKey)
        let bundled = Bundle.main.object(forInfoDictionaryKey: "DefaultRelayURL") as? String
        guard
            let serverURL = URL(string: (configured ?? bundled ?? "http://127.0.0.1:8787").trimmingCharacters(in: .whitespacesAndNewlines)),
            let endpoint = URL(string: "/api/account/desktop-workers", relativeTo: serverURL)?.absoluteURL
        else { return }
        var request = URLRequest(url: endpoint)
        request.setValue(email, forHTTPHeaderField: "X-Relay-Email")
        remoteSyncInFlight = true
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.remoteSyncInFlight = false
                guard
                    let http = response as? HTTPURLResponse,
                    (200..<300).contains(http.statusCode),
                    let data,
                    let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let workers = payload["workers"] as? [[String: Any]]
                else { return }
                do {
                    try self.applyRemoteWorkers(workers, serverURL: serverURL)
                    self.synchronizeWorkers()
                } catch {
                    self.statusText = "后台 AI 同步失败：\(error.localizedDescription)"
                    self.onStatusChanged?(self.statusText)
                }
            }
        }.resume()
    }

    private func applyRemoteWorkers(_ desiredWorkers: [[String: Any]], serverURL: URL) throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let registryURL = home.appendingPathComponent(".group-relay/local-workers.json")
        var registry: [String: Any] = [:]
        if
            let data = try? Data(contentsOf: registryURL),
            let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        { registry = value }
        var workers = registry["workers"] as? [String: Any] ?? [:]
        let desiredIds = Set(desiredWorkers.compactMap { $0["workerId"] as? String })

        for incoming in desiredWorkers {
            guard
                let workerId = incoming["workerId"] as? String,
                workerId.range(of: #"^[a-z0-9-]{1,160}$"#, options: .regularExpression) != nil,
                let provider = incoming["provider"] as? String,
                ["codex", "claude", "cursor"].contains(provider),
                let rawBaseURL = incoming["baseUrl"] as? String,
                URL(string: rawBaseURL)?.host == serverURL.host,
                let groupId = incoming["groupId"] as? String,
                UUID(uuidString: groupId) != nil,
                incoming["email"] as? String != nil
            else { continue }
            if
                let entry = workers[workerId] as? [String: Any],
                let existingFile = entry["configFile"] as? String,
                let existingData = try? Data(contentsOf: URL(fileURLWithPath: existingFile)),
                let existing = try? JSONSerialization.jsonObject(with: existingData) as? [String: Any],
                existing["groupId"] as? String == groupId,
                existing["memberId"] as? String == incoming["memberId"] as? String,
                existing["email"] as? String == incoming["email"] as? String,
                existing["provider"] as? String == provider,
                (existing["baseUrl"] as? String)?.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    == rawBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            { continue }
            var config = incoming
            for value in workers.values {
                guard
                    let entry = value as? [String: Any],
                    entry["provider"] as? String == provider,
                    let configFile = entry["configFile"] as? String,
                    let data = try? Data(contentsOf: URL(fileURLWithPath: configFile)),
                    let template = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                for key in ["model", "agentBin", "workspacePath"] where config[key] == nil {
                    config[key] = template[key]
                }
                break
            }
            if config["workspacePath"] == nil { config["workspacePath"] = home.path }
            let configURL = home
                .appendingPathComponent(".group-relay/desktop-sessions")
                .appendingPathComponent("\(workerId).json")
            try writeJSON(config, to: configURL)
            workers[workerId] = [
                "configFile": configURL.path,
                "groupId": groupId,
                "provider": provider,
                "enabled": true,
                "updatedAt": ISO8601DateFormatter().string(from: Date())
            ]
        }

        var removedWorkers: [(String, String)] = []
        for (workerId, value) in workers where workerId.hasPrefix("desktop-") && !desiredIds.contains(workerId) {
            guard
                let entry = value as? [String: Any],
                let configFile = entry["configFile"] as? String,
                let data = try? Data(contentsOf: URL(fileURLWithPath: configFile)),
                let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let rawBaseURL = config["baseUrl"] as? String,
                URL(string: rawBaseURL)?.host == serverURL.host
            else { continue }
            removedWorkers.append((workerId, configFile))
        }
        for (workerId, configFile) in removedWorkers {
            workers.removeValue(forKey: workerId)
            try? FileManager.default.removeItem(atPath: configFile)
        }
        registry["version"] = 1
        registry["workers"] = workers
        try writeJSON(registry, to: registryURL)
    }

    private func writeJSON(_ value: [String: Any], to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
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
        // 桥接日志没有上限,只会一直涨(实测已经 6MB)。超过 8MB 就轮转一份 .1,总量封在 16MB。
        if let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path))?[.size] as? Int,
           size > 8 * 1024 * 1024 {
            let rotated = logURL.appendingPathExtension("1")
            try? FileManager.default.removeItem(at: rotated)
            try? FileManager.default.moveItem(at: logURL, to: rotated)
        }
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let log = try? FileHandle(forWritingTo: logURL) {
            _ = try? log.seekToEnd()
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] terminatedProcess in
                try? log.close()
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    guard let self, self.processes[workerId] === terminatedProcess else { return }
                    self.processes.removeValue(forKey: workerId)
                    self.synchronizeWorkers()
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
            if process.isRunning { terminateProcessTree(process) }
            processes.removeValue(forKey: workerId)
        }
        updateStatus()
    }

    private func directChildProcessIDs(_ parent: pid_t) -> [pid_t] {
        let query = Process()
        query.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        query.arguments = ["-P", String(parent)]
        let output = Pipe()
        query.standardOutput = output
        query.standardError = FileHandle.nullDevice
        guard (try? query.run()) != nil else { return [] }
        query.waitUntilExit()
        let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return text.split(whereSeparator: { $0.isWhitespace }).compactMap { pid_t($0) }
    }

    private func descendantProcessIDs(_ parent: pid_t) -> [pid_t] {
        directChildProcessIDs(parent).flatMap { child in [child] + descendantProcessIDs(child) }
    }

    private func terminateProcessTree(_ process: Process) {
        let root = process.processIdentifier
        let descendants = descendantProcessIDs(root)
        for pid in descendants.reversed() { _ = Darwin.kill(pid, SIGTERM) }
        _ = Darwin.kill(root, SIGTERM)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
            for pid in descendants.reversed() where Darwin.kill(pid, 0) == 0 { _ = Darwin.kill(pid, SIGKILL) }
            if Darwin.kill(root, 0) == 0 { _ = Darwin.kill(root, SIGKILL) }
        }
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
