import UIKit

enum CustomerScanStatus {
    case ready
    case checking
    case accepted
    case rejected
    case failed

    var title: String {
        switch self {
        case .ready: "Ready"
        case .checking: "Checking pass"
        case .accepted: "You're checked in"
        case .rejected: "Please see staff"
        case .failed: "Please see staff"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "wave.3.right.circle"
        case .checking: "hourglass.circle"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "xmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    var color: UIColor {
        switch self {
        case .ready, .checking: .secondaryLabel
        case .accepted: .systemGreen
        case .rejected: .systemRed
        case .failed: .systemOrange
        }
    }
}

@MainActor
final class CustomerDisplayModel: NSObject {
    var status: CustomerScanStatus = .ready {
        didSet { onChange?() }
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
private final class CustomerDisplayViewController: UIViewController {
    private let model: CustomerDisplayModel
    private let symbol = UIImageView()
    private let titleLabel = UILabel()

    init(model: CustomerDisplayModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let content = UIView()
        content.backgroundColor = .systemBackground
        content.accessibilityIdentifier = "passbook-customer-display"
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
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.safeAreaLayoutGuide.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            symbol.heightAnchor.constraint(equalToConstant: 104),
        ])
        view = content
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onChange = { [weak self] in self?.updateStatus() }
        updateStatus()
    }

    private func updateStatus() {
        titleLabel.text = model.status.title
        titleLabel.accessibilityLabel = model.status.title
        symbol.image = UIImage(systemName: model.status.symbol)
        symbol.tintColor = model.status.color
    }

}
