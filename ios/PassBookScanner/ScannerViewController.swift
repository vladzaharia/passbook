import UIKit
import WebKit

@MainActor
final class ScannerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let hardware = ScannerHardware()
    private var webView: WKWebView!
    private var trustedOrigin: String { "https://\(trustedHost)" }
    private var trustedHost: String { NavigationPolicy.trustedHost }
    static weak var primary: ScannerViewController?
    private var handshake = BridgeHandshake()
    private var gate = ScanGate()
    private var crashPolicy = CrashPolicy()
    /// The scanner is armed: keep the screen awake and let reads through.
    private var armed = false {
        didSet { UIApplication.shared.isIdleTimerDisabled = armed }
    }
    private var holdTimer: Task<Void, Never>?
    private var customerDisplayExpiry: Task<Void, Never>?
    private var customerDisplayGeneration = 0
    private let customerDisplay = CustomerDisplayModel()
    private var customerRegistration: AnyObject?
    private var loadErrorView: UIView?

    override func loadView() {
        let content = WKUserContentController()
        content.add(WeakScriptHandler(self), name: "passbookNative")
        content.addUserScript(WKUserScript(source: """
          (() => { const bridge={onmessage:null,postMessage(message){window.webkit.messageHandlers.passbookNative.postMessage(message)}}; Object.defineProperty(window,'PassBookNative',{value:bridge,configurable:false}); })();
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = content
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
#endif
        view = webView
        hardware.onChange = { [weak self] in self?.refreshCapabilities() }
        hardware.onRead = { [weak self] value, method in self?.sendScan(value, method: method) }
        hardware.onTag = { [weak self] id, result in self?.sendTagScan(id: id, result: result) }
        hardware.onCancelled = { [weak self] in self?.send(["event": "cancelled"]) }
        Self.primary = self
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        registerCustomerDisplay()
        loadScanner()
    }

    private func loadScanner() {
        let url = URL(string: "\(trustedOrigin)/scan")!
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        refreshCapabilities()
    }
    @available(iOS 26.0, *)
    override func updateProperties() {
        super.updateProperties()
        refreshCapabilities()
    }

    func pause() {
        armed = false
        resetScanState()
        setCustomerDisplayStatus(.ready)
        hardware.stop()
        send(["event": "cancelled"])
    }

    /// Ends a scene's scanner: nothing keeps running for a window that is gone.
    func teardown() {
        armed = false
        resetScanState()
        hardware.stop()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "passbookNative")
        webView.stopLoading()
        if Self.primary === self { Self.primary = nil }
    }

    private func resetScanState() {
        holdTimer?.cancel()
        holdTimer = nil
        _ = gate.reset()
    }

    func refreshCapabilities() {
        guard webView.url?.host == trustedHost, webView.url?.scheme == "https" else { return }
        var capabilities = hardware.capabilities
        capabilities["layout"] = layoutCapabilities()
        capabilities["customerDisplay"] = customerDisplayCapabilities()
        guard let data = try? JSONSerialization.data(withJSONObject: capabilities, options: [.sortedKeys]),
              let kind = handshake.outgoing(snapshot: data) else { return }
        var message: [String: Any] = [
            "event": kind == .ready ? "ready" : "capabilities",
            "capabilities": capabilities,
            "features": BridgeHandshake.advertisedFeatures,
        ]
        if kind == .ready {
            let nfc = capabilities["nfc"] as? [String: Any]
            message["nfc"] = nfc?["available"] as? Bool ?? false
            message["ecp"] = false
            message["diagnostics"] = false
            message["appVersion"] = capabilities["appVersion"] as? String ?? "1"
        }
        send(message)
    }

    /// Sends the next queued scan once the app is not in the background. The Core NFC sheet leaves the app
    /// inactive, not backgrounded, and the web view is alive then, so reads are delivered directly.
    func pump() {
        guard handshake.ready, UIApplication.shared.applicationState != .background,
              let item = gate.takeNext() else { return }
        let id = item.id
        let limit = gate.holdLimit
        holdTimer?.cancel()
        holdTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(limit))
            guard let self, !Task.isCancelled else { return }
            self.holdTimer = nil
            if self.gate.expire(id: id) { self.send(["event": "timeout"]) }
            self.pump()
        }
        send(item.event)
    }

    private func releaseGate(id: String, byAck: Bool) {
        guard gate.release(id: id, byAck: byAck) else { return }
        holdTimer?.cancel()
        holdTimer = nil
        pump()
    }

    private func layoutCapabilities() -> [String: Any] {
        var posture = "unknown"
        var division: Any = NSNull()
        if #available(iOS 27.1, *),
           let region = webView.reservedRegions(kind: .division, options: .includeInactive).first {
            posture = region.isActive ? "half-folded" : "unfolded"
            division = [
                "x": max(0, region.frame.minX),
                "y": max(0, region.frame.minY),
                "width": max(0, region.frame.width),
                "height": max(0, region.frame.height)
            ]
        }
        return ["posture": posture, "division": division]
    }
    private func registerCustomerDisplay() {
        guard #available(iOS 27.1, *) else { return }
        let configuration = UISceneConfiguration()
        configuration.delegateClass = CustomerSceneDelegate.self
        let accessory = UISceneAccessory.cameraCapture(
            sceneConfiguration: configuration,
            userInfo: customerDisplay,
        )
        customerRegistration = registerSceneAccessory(accessory)
    }

    private func customerDisplayCapabilities() -> [String: Any] {
        guard #available(iOS 27.1, *) else {
            return ["supported": false, "available": false, "active": false]
        }
        let registration = customerRegistration as? UISceneAccessoryRegistration
        let available = registration?.isAvailable ?? false
        let active = available && (registration?.isEnabled ?? false)
        return ["supported": true, "available": available, "active": active]
    }
    private func setCustomerDisplayStatus(
        _ status: CustomerScanStatus,
        expiresAfter: Duration? = nil
    ) {
        customerDisplayExpiry?.cancel()
        customerDisplayExpiry = nil
        customerDisplayGeneration += 1
        let generation = customerDisplayGeneration
        customerDisplay.status = status
        guard let expiresAfter else { return }
        customerDisplayExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(for: expiresAfter)
            guard let self, !Task.isCancelled, self.customerDisplayGeneration == generation else { return }
            self.customerDisplayExpiry = nil
            self.customerDisplay.status = .ready
        }
    }


    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "passbookNative", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == trustedHost,
              message.frameInfo.securityOrigin.protocol == "https",
              let raw = message.body as? String, raw.utf8.count <= 8192,
              let data = raw.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = request["version"] as? Int, version == 1 || version == 2,
              let op = request["op"] as? String,
              handshake.accepts(version: version, op: op) else { return }
        let inForeground = UIApplication.shared.applicationState != .background
        let ready = handshake.ready
        switch op {
        case "hello":
            handshake.hello(version: version, versions: request["versions"] as? [Int],
                            features: request["features"] as? [String])
            hardware.tagsEnabled = handshake.wireVersion == 2
            gate.ackEnabled = handshake.scanAck
            refreshCapabilities()
        case "start":
            guard ready, inForeground else { return }
            armed = true
            hardware.start()
        case "stop": pause()
        case "nfcRead":
            guard ready, armed, inForeground else { return }
            hardware.readNFC()
        case "tagRead":
            guard ready, handshake.wireVersion == 2, inForeground,
                  let id = request["id"] as? String, (1...100).contains(id.count),
                  let prompt = request["prompt"] as? String, prompt.count <= 200,
                  let timeoutMs = request["timeoutMs"] as? Int, (1...60000).contains(timeoutMs) else {
                if ready, handshake.wireVersion == 2 {
                    Log.bridge.error("tagRead.invalid")
                    send(["event": "cancelled"])
                }
                return
            }
            // A read in flight keeps its own verdict: say busy, never cancelled.
            guard !gate.isBusy, !hardware.tagReading else { send(["event": "busy", "id": id]); return }
            hardware.readTag(id: id, prompt: prompt, timeoutMs: timeoutMs)
        case "tagCancel":
            guard handshake.wireVersion == 2, let id = request["id"] as? String else { return }
            hardware.cancelTag(id: id)
        case "scanAck":
            guard let id = request["id"] as? String else { return }
            releaseGate(id: id, byAck: true)
        case "result":
            guard let id = request["id"] as? String,
                  let outcome = request["outcome"] as? String,
                  ["accepted", "rejected", "error"].contains(outcome) else { return }
            releaseGate(id: id, byAck: false)
        case "revise", "dropped":
            // scanSettle: no pending ids and no native buzz here; the web view shows the verdict.
            return
        case "haptic":
            guard let pattern = request["pattern"] as? [Int], let kind = Self.hapticKind(pattern) else { return }
            switch kind {
            case .tap: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        case "customerBranding":
            guard ready,
                  let payload = request["branding"] as? [String: Any],
                  let branding = CustomerDisplayBranding(payload: payload) else { return }
            customerDisplay.branding = branding
        case "customerStatus":
            guard ready, armed, inForeground,
                  let status = request["status"] as? String else { return }
            let display = customerDisplayCapabilities()
            guard display["supported"] as? Bool == true,
                  display["available"] as? Bool == true else { return }
            switch status {
            case "ready": setCustomerDisplayStatus(.ready)
            case "checking": setCustomerDisplayStatus(.checking)
            case "accepted": setCustomerDisplayStatus(.accepted, expiresAfter: .seconds(4))
            case "checkedOut": setCustomerDisplayStatus(.checkedOut, expiresAfter: .seconds(4))
            case "rejected": setCustomerDisplayStatus(.rejected, expiresAfter: .seconds(6))
            case "failed": setCustomerDisplayStatus(.failed, expiresAfter: .seconds(6))
            default: return
            }
        default: return
        }
    }

    enum HapticKind { case tap, warning, error }

    /// The web's pulse pattern, as the nearest system feedback: one pulse, two, three or more.
    /// At most 8 entries, each 0 to 500 ms; anything else is dropped.
    static func hapticKind(_ pattern: [Int]) -> HapticKind? {
        guard !pattern.isEmpty, pattern.count <= 8, pattern.allSatisfy({ (0...500).contains($0) }) else { return nil }
        let pulses = (pattern.count + 1) / 2
        return pulses == 1 ? .tap : pulses == 2 ? .warning : .error
    }

    private func sendScan(_ value: String, method: String) {
        guard method == "nfc" || method == "wedge", value.utf8.count <= 2048,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            Log.bridge.error("scan.invalid")
            return
        }
        guard handshake.ready, armed else {
            Log.bridge.error("scan.notArmed")
            send(["event": "cancelled"])
            return
        }
        let id = UUID().uuidString
        let event: [String: Any] = ["event": "scan", "id": id, "readAt": Self.nowMs, "source": "barcode",
                                    "value": value, "method": method]
        enqueue(ScanGate.Item(id: id, source: method, dedupeKey: "\(method)|\(value)", event: event))
    }

    private func sendTagScan(id: String, result: TagReadResult) {
        guard handshake.ready, handshake.wireVersion == 2 else {
            Log.bridge.error("tag.notReady")
            send(["event": "cancelled"])
            return
        }
        let event: [String: Any] = ["event": "scan", "id": id, "readAt": Self.nowMs, "source": "nfc-tag", "tag": result.wire]
        enqueue(ScanGate.Item(id: id, source: "nfc-tag", dedupeKey: nil, event: event))
    }

    private static var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func enqueue(_ item: ScanGate.Item) {
        switch gate.enqueue(item, now: ProcessInfo.processInfo.systemUptime) {
        case .queued: pump()
        case .duplicate: Log.bridge.info("scan.duplicate")
        case .full:
            Log.bridge.error("scan.queueFull")
            send(["event": "busy"])
        }
    }

    private func send(_ fields: [String: Any]) {
        guard webView.url?.host == trustedHost, webView.url?.scheme == "https" else { return }
        var event = fields
        event["version"] = handshake.wireVersion
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8),
              let script = try? JSONSerialization.data(withJSONObject: [json]),
              let argument = String(data: script, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.PassBookNative?.onmessage?.({data:\(argument)[0]})")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let decision = NavigationPolicy.decide(
            url: url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
            isTargetFrameNil: navigationAction.targetFrame == nil,
            isLinkTap: navigationAction.navigationType == .linkActivated)
        switch decision {
        case .allow:
            decisionHandler(.allow)
        case .cancel:
            Log.bridge.info("nav.blocked")
            decisionHandler(.cancel)
        case .openExternally:
            decisionHandler(.cancel)
            if let url { UIApplication.shared.open(url) }
            // The scanner page stays up. If there is none (a redirect on first load), offer Reload.
            if webView.url?.host != trustedHost { showLoadError() }
        }
    }

    /// Cancelled and policy-interrupted loads are not failures.
    private func isBenign(_ error: Error) -> Bool {
        let nsError = error as NSError
        return (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
            || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102)
    }

    private func resetBridge() {
        handshake.reset()
        gate.ackEnabled = false
        hardware.tagsEnabled = false
        armed = false
        resetScanState()
        setCustomerDisplayStatus(.ready)
        hardware.stop()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        resetBridge()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.bridge.error("web.terminated")
        resetBridge()
        switch crashPolicy.record(now: ProcessInfo.processInfo.systemUptime) {
        case .reload: loadScanner()
        case .askOperator: showLoadError(message: "The scanner stopped. Reload to continue.")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadErrorView?.removeFromSuperview()
        loadErrorView = nil
        refreshCapabilities()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !isBenign(error) else { return }
        Log.bridge.error("load.failed")
        showLoadError()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard !isBenign(error) else { return }
        Log.bridge.error("load.failed")
        showLoadError()
    }

    private func showLoadError(message: String = "Could not load the scanner. Check your connection.") {
        guard loadErrorView == nil else { return }

        let label = UILabel()
        label.text = message
        label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center

        let retryButton = UIButton(type: .system)
        retryButton.setTitle("Reload scanner", for: .normal)
        retryButton.titleLabel?.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
        retryButton.titleLabel?.adjustsFontForContentSizeCategory = true
        retryButton.accessibilityIdentifier = "scannerLoadRetry"
        retryButton.addAction(UIAction { [weak self] _ in
            self?.crashPolicy.reset()
            self?.loadScanner()
        }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [label, retryButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false

        let overlay = UIView()
        overlay.backgroundColor = .systemBackground
        overlay.accessibilityIdentifier = "scannerLoadError"
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        view.addSubview(overlay)

        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
        ])
        loadErrorView = overlay
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        guard type == .camera, origin.host == trustedHost, origin.protocol == "https", frame.isMainFrame,
              UIApplication.shared.applicationState != .background else { decisionHandler(.deny); return }
        // The system alert leaves the app inactive while the grant arrives, so only a background app is refused.
        hardware.requestCameraPermission { [weak self] granted in
            guard let self, UIApplication.shared.applicationState != .background,
                  self.webView.url?.host == self.trustedHost, self.webView.url?.scheme == "https" else {
                decisionHandler(.deny); return
            }
            decisionHandler(granted ? .grant : .deny)
        }
    }
}

/// Holds the view controller weakly: WKUserContentController retains its handlers for the web view's life.
@MainActor
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
