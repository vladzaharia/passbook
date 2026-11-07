import UIKit
import WebKit

@MainActor
final class ScannerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let hardware = ScannerHardware()
    private var webView: WKWebView!
    private let trustedHost = "passbook.mobile"
    private var trustedOrigin: String { "https://\(trustedHost)" }
    private var ready = false
    private var armed = false
    private var pendingID: String?
    private var scanTimeout: Task<Void, Never>?
    private var lastCapabilities: Data?
    private let customerDisplay = CustomerDisplayModel()
    private var customerRegistration: AnyObject?
    private var loadErrorView: UIView?

    override func loadView() {
        let content = WKUserContentController()
        content.add(self, name: "passbookNative")
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
        webView.isInspectable = _isDebugAssertConfiguration()
        view = webView
        hardware.onChange = { [weak self] in self?.refreshCapabilities() }
        hardware.onRead = { [weak self] value, method in self?.sendScan(value, method: method) }
        hardware.onCancelled = { [weak self] in self?.send(["event": "cancelled"]) }
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
        pendingID = nil
        scanTimeout?.cancel()
        scanTimeout = nil
        customerDisplay.status = .ready
        hardware.stop()
        send(["event": "cancelled"])
    }

    func refreshCapabilities(force: Bool = false) {
        guard webView.url?.host == trustedHost, webView.url?.scheme == "https" else { return }
        var capabilities = hardware.capabilities
        capabilities["layout"] = layoutCapabilities()
        capabilities["customerDisplay"] = customerDisplayCapabilities()
        guard let data = try? JSONSerialization.data(withJSONObject: capabilities, options: [.sortedKeys]) else { return }
        if !force && lastCapabilities == data { return }
        lastCapabilities = data
        send(["event": ready ? "capabilities" : "ready", "capabilities": capabilities])
    }

    private func layoutCapabilities() -> [String: Any] {
        var posture = "unknown"
        var division: Any = NSNull()
        if #available(iOS 27.1, *),
           let region = webView.reservedRegions(kind: .division, options: .includeInactive).first {
            if region.isActive {
                posture = "half-folded"
                division = [
                    "x": max(0, region.frame.minX),
                    "y": max(0, region.frame.minY),
                    "width": max(0, region.frame.width),
                    "height": max(0, region.frame.height)
                ]
            } else {
                posture = "unfolded"
            }
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


    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "passbookNative", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == trustedHost,
              message.frameInfo.securityOrigin.protocol == "https",
              let raw = message.body as? String, raw.utf8.count <= 8192,
              let data = raw.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              request["version"] as? Int == 1, let op = request["op"] as? String else { return }
        switch op {
        case "hello":
            ready = true
            refreshCapabilities(force: true)
        case "start":
            guard ready, UIApplication.shared.applicationState == .active else { return }
            armed = true
            hardware.start()
        case "stop": pause()
        case "nfcRead":
            guard ready, armed, UIApplication.shared.applicationState == .active else { return }
            hardware.readNFC()
        case "result":
            guard request["id"] as? String == pendingID,
                  let outcome = request["outcome"] as? String,
                  ["accepted", "rejected", "error"].contains(outcome) else { return }
            pendingID = nil
            scanTimeout?.cancel()
            scanTimeout = nil
            customerDisplay.status = switch outcome {
            case "accepted": .accepted
            case "rejected": .rejected
            default: .failed
            }
        default: return
        }
    }

    private func sendScan(_ value: String, method: String) {
        guard ready, armed, UIApplication.shared.applicationState == .active, pendingID == nil,
              method == "nfc" || method == "wedge",
              value.utf8.count <= 2048,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return }
        let id = UUID().uuidString
        pendingID = id
        customerDisplay.status = .checking
        scanTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled, self.pendingID == id else { return }
            self.pendingID = nil
            self.scanTimeout = nil
            self.customerDisplay.status = .failed
            self.send(["event": "timeout"])
        }
        send(["event": "scan", "id": id, "source": "barcode", "value": value, "method": method])
    }

    private func send(_ fields: [String: Any]) {
        guard webView.url?.host == trustedHost, webView.url?.scheme == "https" else { return }
        var event = fields
        event["version"] = 1
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8),
              let script = try? JSONSerialization.data(withJSONObject: [json]),
              let argument = String(data: script, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.PassBookNative?.onmessage?.({data:\(argument)[0]})")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let url = navigationAction.request.url, url.scheme == "https" else {
            decisionHandler(.cancel); pause(); return
        }
        if url.host == trustedHost || navigationAction.navigationType == .linkActivated {
            if url.host != trustedHost { UIApplication.shared.open(url) }
            decisionHandler(url.host == trustedHost ? .allow : .cancel)
            if url.host != trustedHost { pause() }
            return
        }
        decisionHandler(.allow)
        pause()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        ready = false
        armed = false
        pendingID = nil
        scanTimeout?.cancel()
        scanTimeout = nil
        customerDisplay.status = .ready
        hardware.stop()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadErrorView?.removeFromSuperview()
        loadErrorView = nil
        refreshCapabilities()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showLoadError() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showLoadError() }

    private func showLoadError() {
        guard loadErrorView == nil else { return }

        let label = UILabel()
        label.text = "Could not load the scanner. Check your connection."
        label.numberOfLines = 0
        label.textAlignment = .center

        let retryButton = UIButton(type: .system)
        retryButton.setTitle("Retry", for: .normal)
        retryButton.accessibilityIdentifier = "scannerLoadRetry"
        retryButton.addAction(UIAction { [weak self] _ in self?.loadScanner() }, for: .touchUpInside)

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
              UIApplication.shared.applicationState == .active else { decisionHandler(.deny); return }
        hardware.requestCameraPermission { [weak self] granted in
            guard let self, UIApplication.shared.applicationState == .active,
                  self.webView.url?.host == self.trustedHost, self.webView.url?.scheme == "https" else {
                decisionHandler(.deny); return
            }
            decisionHandler(granted ? .grant : .deny)
        }
    }
}
