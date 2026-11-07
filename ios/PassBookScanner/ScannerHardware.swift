import AVFoundation
import Foundation
import UIKit
import ProximityReader

@MainActor
final class ScannerHardware {
    var onChange: (() -> Void)?
    var onRead: ((String, String) -> Void)?
    var onCancelled: (() -> Void)?
    private(set) var readingNFC = false

    var capabilities: [String: Any] {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        return [
            "platform": "ios",
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1",
            "camera": ["available": AVCaptureDevice.default(for: .video) != nil, "permission": permission(status)],
            "keyboard": ["supported": true, "connected": NSNull(), "connectionObservable": false],
            "nfc": ["available": NFCReader.available, "reading": readingNFC, "formats": NFCReader.available ? ["ndef"] : []],
            "vas": ["deviceSupported": PaymentCardReader.isSupported, "available": false, "reader": "proximityReader", "reason": "Wallet VAS needs Apple reader entitlement, a supported payment provider, and server verification."],
            "externalReader": ["mode": "keyboard", "connected": NSNull()],
            "customerDisplay": ["supported": false, "available": false, "active": false]
        ]
    }

    func start() { onChange?() }
    func stop() {
        if readingNFC { onCancelled?() }
        setNFCReading(false)
        NFCReader.stop()
        onChange?()
    }
    func setNFCReading(_ value: Bool) {
        readingNFC = value
        onChange?()
    }
    func readNFC() { NFCReader.start(owner: self) }
    func requestCameraPermission(_ completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in self.onChange?(); completion(granted) }
            }
        } else {
            completion(status == .authorized)
        }
    }

    private func permission(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: "prompt"
        case .authorized: "granted"
        case .denied: "denied"
        case .restricted: "restricted"
        @unknown default: "unavailable"
        }
    }
}
