import AppKit
import Foundation
import WebKit

@main
struct ReadPodcastMain {
    private static let delegate = ReadPodcastAppDelegate()

    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
    }
}

final class ReadPodcastAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serviceProcess: Process?
    private var readinessTimer: Timer?
    private var startupDeadline = Date()
    private var didLoadApplication = false
    private var isTerminating = false
    private var popupWindows: [ObjectIdentifier: NSWindow] = [:]
    private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]

    private var applicationPort: String {
        ProcessInfo.processInfo.environment["READ_PODCAST_PORT"] ?? "28000"
    }

    private var applicationURL: URL {
        URL(string: "http://127.0.0.1:\(applicationPort)/")!
    }

    private var healthURL: URL {
        applicationURL.appendingPathComponent("api/read-podcast/health")
    }

    private var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Read Podcast/app.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        configureWindow()
        showLoadingPage()
        launchServices()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        readinessTimer?.invalidate()
        stopServices()
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Read Podcast"
        window.minSize = NSSize(width: 900, height: 640)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    private func configureMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 Read Podcast", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 Read Podcast", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 Read Podcast", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        viewItem.submenu = viewMenu
        let reloadItem = viewMenu.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        let backItem = viewMenu.addItem(withTitle: "后退", action: #selector(goBack), keyEquivalent: "[")
        backItem.target = self
        let forwardItem = viewMenu.addItem(withTitle: "前进", action: #selector(goForward), keyEquivalent: "]")
        forwardItem.target = self

        let helpItem = NSMenuItem()
        mainMenu.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助")
        helpItem.submenu = helpMenu
        let logItem = helpMenu.addItem(withTitle: "打开运行日志", action: #selector(openLog), keyEquivalent: "")
        logItem.target = self

        NSApp.mainMenu = mainMenu
    }

    private func launchServices() {
        guard let launcherURL = Bundle.main.resourceURL?.appendingPathComponent("launcher.sh") else {
            showFailure("安装包缺少服务启动器。")
            return
        }

        let process = Process()
        process.executableURL = launcherURL
        process.currentDirectoryURL = Bundle.main.resourceURL
        process.environment = ProcessInfo.processInfo.environment
        process.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self, !self.isTerminating else { return }
                self.readinessTimer?.invalidate()
                self.showFailure("后台服务已退出（状态码 \(task.terminationStatus)）。")
            }
        }

        do {
            try process.run()
            serviceProcess = process
        } catch {
            showFailure("无法启动后台服务：\(error.localizedDescription)")
            return
        }

        startupDeadline = Date().addingTimeInterval(90)
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.probeHealth()
        }
        probeHealth()
    }

    private func probeHealth() {
        guard !didLoadApplication else { return }
        if Date() >= startupDeadline {
            readinessTimer?.invalidate()
            showFailure("服务在 90 秒内没有就绪。")
            return
        }

        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 0.4
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            DispatchQueue.main.async {
                guard let self, !self.didLoadApplication else { return }
                self.didLoadApplication = true
                self.readinessTimer?.invalidate()
                self.webView.load(URLRequest(url: self.applicationURL))
            }
        }.resume()
    }

    private func stopServices() {
        guard let process = serviceProcess, process.isRunning else { return }
        process.terminate()
    }

    private func showLoadingPage() {
        showLocalPage(
            title: "正在启动 Read Podcast",
            message: "正在准备网页服务和语音转录后端，首次启动可能需要一点时间。",
            showLogLink: false
        )
    }

    private func showFailure(_ details: String) {
        guard !isTerminating else { return }
        showLocalPage(
            title: "Read Podcast 未能启动",
            message: details + " 请确认 ffmpeg 已安装，且 28000、21567 端口没有被其他程序占用。",
            showLogLink: true
        )
    }

    private func showLocalPage(title: String, message: String, showLogLink: Bool) {
        let escapedTitle = escapeHTML(title)
        let escapedMessage = escapeHTML(message)
        let link = showLogLink ? #"<p><a href="readpodcast://open-log">打开运行日志</a></p>"# : ""
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        :root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px -apple-system,BlinkMacSystemFont,sans-serif;background:#f5f1e8;color:#302a23}.card{max-width:560px;margin:32px;padding:40px;border:1px solid #d8d0c2;border-radius:18px;background:#fffdf8;box-shadow:0 18px 50px #3b2f2018;text-align:center}h1{font-size:24px;margin:0 0 14px}p{line-height:1.65;margin:0;color:#6b6258}a{color:#9a4d2e}@media(prefers-color-scheme:dark){body{background:#211f1c;color:#f1ece3}.card{background:#2a2723;border-color:#49433b}p{color:#c7bfb5}}
        </style></head><body><main class="card"><h1>\(escapedTitle)</h1><p>\(escapedMessage)</p>\(link)</main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    @objc private func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func goForward() {
        if webView.canGoForward { webView.goForward() }
    }

    @objc private func openLog() {
        NSWorkspace.shared.open(logURL)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.scheme == "readpodcast" {
            if navigationAction.request.url?.host == "open-log" { openLog() }
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        retain(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        retain(download)
    }

    private func retain(_ download: WKDownload) {
        activeDownloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownloads.removeValue(forKey: ObjectIdentifier(download))
        let nsError = error as NSError
        let description = nsError.localizedDescription.lowercased()
        if (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
            || description == "cancelled"
            || description == "canceled" {
            return
        }
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil else { return nil }
        let popup = WKWebView(frame: NSRect(x: 0, y: 0, width: 560, height: 720), configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let popupWindow = NSWindow(
            contentRect: popup.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        popupWindow.title = "Read Podcast"
        popupWindow.contentView = popup
        popupWindow.center()
        popupWindow.makeKeyAndOrderFront(nil)
        popupWindows[ObjectIdentifier(popup)] = popupWindow
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        popupWindows.removeValue(forKey: ObjectIdentifier(webView))?.close()
    }
}
