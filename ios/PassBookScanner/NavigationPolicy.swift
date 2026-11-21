import Foundation

/// Where the scanner's web view may go. The main frame stays on PassBook; everything else opens outside the
/// app, so the scanner is always one Reload away. Subframes are limited to an explicit allowlist.
enum NavigationPolicy {
    enum Decision: Equatable { case allow, openExternally, cancel }

    static let trustedHost = "passbook.mobile"
    /// Turnstile's challenge frame on /login.
    static let frameHosts: Set<String> = ["challenges.cloudflare.com"]

    static func decide(url: URL?, isMainFrame: Bool, isTargetFrameNil: Bool = false, isLinkTap: Bool = false) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if isMainFrame {
            if scheme == "https", url.host?.lowercased() == trustedHost { return .allow }
            return externallyOpenable(scheme) ? .openExternally : .cancel
        }
        if isTargetFrameNil { return externallyOpenable(scheme) && isLinkTap ? .openExternally : .cancel }
        if scheme == "about" { return .allow }
        guard scheme == "https", let host = url.host?.lowercased() else { return .cancel }
        return host == trustedHost || frameHosts.contains(host) ? .allow : .cancel
    }

    private static func externallyOpenable(_ scheme: String) -> Bool {
        ["https", "http", "mailto", "tel", "sms"].contains(scheme)
    }
}
