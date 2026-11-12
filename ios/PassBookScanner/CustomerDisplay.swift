import UIKit
import WebKit

enum CustomerScanStatus: String {
    case ready
    case checking
    case accepted
    case checkedOut
    case rejected
    case failed

    var title: String {
        switch self {
        case .ready: "Ready"
        case .checking: "Checking pass"
        case .accepted: "You're checked in"
        case .checkedOut: "You're checked out"
        case .rejected: "Please see staff"
        case .failed: "Please see staff"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "wave.3.right.circle"
        case .checking: "hourglass.circle"
        case .checkedOut: "checkmark.circle.fill"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "xmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    var color: UIColor {
        switch self {
        case .ready, .checking: .secondaryLabel
        case .accepted, .checkedOut: .systemGreen
        case .rejected: .systemRed
        case .failed: .systemOrange
        }
    }
}

struct CustomerDisplayBranding: Equatable {
    let name: String
    let accent: String?
    let logoSha: String?

    init(name: String, accent: String?, logoSha: String?) {
        self.name = name
        self.accent = accent
        self.logoSha = logoSha
    }

    init?(payload: [String: Any]) {
        guard Set(payload.keys) == Set(["name", "accent", "logoSha"]),
              let rawName = payload["name"] as? String else { return nil }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 120 else { return nil }

        let accentValue = payload["accent"]
        let logoValue = payload["logoSha"]
        guard accentValue is NSNull || accentValue is String,
              logoValue is NSNull || logoValue is String else { return nil }
        let accent = accentValue as? String
        let logoSha = logoValue as? String
        if let accent, accent.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) == nil {
            return nil
        }
        if let logoSha, logoSha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) == nil {
            return nil
        }
        self.name = name
        self.accent = accent
        self.logoSha = logoSha
    }

    var payload: [String: Any] {
        var value: [String: Any] = ["name": name, "accent": NSNull(), "logoSha": NSNull()]
        if let accent { value["accent"] = accent }
        if let logoSha { value["logoSha"] = logoSha }
        return value
    }
}

@MainActor
final class CustomerDisplayModel: NSObject {
    var revision = 0
    var branding = CustomerDisplayBranding(name: "PassBook", accent: nil, logoSha: nil) {
        didSet {
            revision += 1
            onChange?()
        }
    }
    var status: CustomerScanStatus = .ready {
        didSet {
            revision += 1
            onChange?()
        }
    }
    var onChange: (() -> Void)?
}

@available(iOS 27.0, *)
@MainActor
final class CustomerSceneDelegate: NSObject, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene,
              let model = connectionOptions.sceneAccessoryUserInfo as? CustomerDisplayModel else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = CustomerDisplayViewController(model: model)
        window.makeKeyAndVisible()
        self.window = window
    }
}

@MainActor
private final class CustomerDisplayViewController: UIViewController, WKNavigationDelegate {
    private let model: CustomerDisplayModel
    private let fallbackView = UIView()
    private let symbol = UIImageView()
    private let titleLabel = UILabel()
    private var webView: WKWebView!
    private let trustedHost = "passbook.mobile"

    init(model: CustomerDisplayModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let content = UIView()
        content.backgroundColor = .systemBackground
        content.accessibilityIdentifier = "passbook-customer-display"

        let userContent = WKUserContentController()
        userContent.addUserScript(WKUserScript(source: """
          (() => {
            const bridge = {
              status: 'ready',
              revision: 0,
              branding: {name: 'PassBook', accent: null, logoSha: null},
              onmessage: null,
              update(value) {
                this.status = value.status;
                this.revision = value.revision;
                this.branding = value.branding ?? this.branding;
                this.onmessage?.({data: JSON.stringify(value)});
              }
            };
            Object.defineProperty(window, 'PassBookCustomerDisplay', {value: bridge, configurable: false});
          })();
          """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = userContent
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.isScrollEnabled = false
        webView.isHidden = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        fallbackView.backgroundColor = .systemBackground
        fallbackView.translatesAutoresizingMaskIntoConstraints = false
        let stack = UIStackView(arrangedSubviews: [symbol, titleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 88, weight: .regular)
        titleLabel.font = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .largeTitle).pointSize, weight: .semibold)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 2
        titleLabel.adjustsFontForContentSizeCategory = true
        fallbackView.addSubview(stack)
        content.addSubview(webView)
        content.addSubview(fallbackView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            fallbackView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            fallbackView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            fallbackView.topAnchor.constraint(equalTo: content.topAnchor),
            fallbackView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: fallbackView.safeAreaLayoutGuide.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: fallbackView.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: fallbackView.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: fallbackView.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            symbol.heightAnchor.constraint(equalToConstant: 104),
        ])
        view = content
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onChange = { [weak self] in self?.updateStatus() }
        updateStatus()
        let url = URL(string: "https://\(trustedHost)/scan?customer-display=1")!
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    private func updateStatus() {
        titleLabel.text = model.status.title
        titleLabel.accessibilityLabel = model.status.title
        symbol.image = UIImage(systemName: model.status.symbol)
        symbol.tintColor = model.status.color
        guard webView.url?.host == trustedHost, webView.url?.scheme == "https",
              let data = try? JSONSerialization.data(
                withJSONObject: [
                    "status": model.status.rawValue,
                    "revision": model.revision,
                    "branding": model.branding.payload,
                ]
              ),
              let message = String(data: data, encoding: .utf8),
              let argumentData = try? JSONSerialization.data(withJSONObject: [message]),
              let argument = String(data: argumentData, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.PassBookCustomerDisplay?.update(JSON.parse(\(argument)[0]))"
        )
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let url = navigationAction.request.url,
              url.scheme == "https",
              url.host == trustedHost else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.isHidden = false
        fallbackView.isHidden = true
        updateStatus()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webView.isHidden = true
        fallbackView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.isHidden = true
        fallbackView.isHidden = false
    }
}
