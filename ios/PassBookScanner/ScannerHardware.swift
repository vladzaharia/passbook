import AVFoundation
import Foundation
import UIKit
import ProximityReader

@MainActor
final class ScannerHardware {
    var onChange: (() -> Void)?
    var onRead: ((String, String) -> Void)?
    var onTag: ((String, TagReadResult) -> Void)?
    var onCancelled: (() -> Void)?
    var tagsEnabled = false
    private(set) var readingNFC = false

    var capabilities: [String: Any] {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        return [
            "platform": "ios",
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1",
            "camera": ["available": AVCaptureDevice.default(for: .video) != nil, "permission": permission(status)],
            "keyboard": ["supported": true, "connected": NSNull(), "connectionObservable": false],
            "nfc": ["available": NFCReader.available, "reading": readingNFC, "formats": nfcFormats, "continuous": false],
            "vas": ["deviceSupported": PaymentCardReader.isSupported, "available": false, "reader": "proximityReader", "reason": "Wallet VAS needs Apple reader entitlement, a supported payment provider, and server verification."],
            "externalReader": ["mode": "keyboard", "connected": NSNull()],
            "customerDisplay": ["supported": false, "available": false, "active": false]
        ]
    }

    private var nfcFormats: [String] {
        guard NFCReader.available else { return [] }
        // The TAG entitlement is not detectable at runtime (no public API; embedded.mobileprovision is absent
        // from App Store builds), so check-archive.sh verifies it at build time. Without it begin() fails and the
        // read answers cancelled.
        return tagsEnabled && TagReader.available ? ["ndef", "tag-uid"] : ["ndef"]
    }

    func start() { onChange?() }
    func stop() {
        if readingNFC { onCancelled?() }
        setNFCReading(false)
        NFCReader.stop()
        TagReader.stop()
        onChange?()
    }
    func setNFCReading(_ value: Bool) {
        readingNFC = value
        onChange?()
    }
    func readNFC() { NFCReader.start(owner: self) }
    func readTag(id: String, prompt: String, timeoutMs: Int) { TagReader.start(owner: self, id: id, prompt: prompt, timeoutMs: timeoutMs) }
    func cancelTag(id: String) { TagReader.cancel(id: id) }
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
