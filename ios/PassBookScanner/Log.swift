import os

/// Field diagnostics. Codes only: never a scan value, tag data, token or URL.
enum Log {
    static let bridge = Logger(subsystem: "mobile.passbook.scanner", category: "bridge")
}
