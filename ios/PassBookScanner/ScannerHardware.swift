import AVFoundation
import CoreHaptics
import Foundation
import GameController
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

    private nonisolated(unsafe) var keyboardObservers: [NSObjectProtocol] = []

    init() {
        // A wedge scanner appears as a hardware keyboard; report it when it connects or goes away.
        for name in [NSNotification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
            let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.onChange?() }
            }
            keyboardObservers.append(token)
        }
    }

    deinit { keyboardObservers.forEach { NotificationCenter.default.removeObserver($0) } }

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
            "customerDisplay": ["supported": false, "available": false, "active": false],
            "haptics": true,
            "hardware": HardwareMap.entries(hardwareInput(permission(status)))
        ]
    }

    private func hardwareInput(_ cameraPermission: String) -> HardwareMap.Input {
        let types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .builtInUltraWideCamera,
                                                   .builtInTelephotoCamera, .external]
        let cameras = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified)
            .devices.map { device in
                let facing = device.deviceType == .external ? "external"
                    : device.position == .front ? "front" : device.position == .back ? "back" : "external"
                return HardwareMap.Camera(facing: facing, name: device.localizedName)
            }
        let keyboard = GCKeyboard.coalesced.map { $0.vendorName ?? "Keyboard" }
        return HardwareMap.Input(cameras: cameras, cameraPermission: cameraPermission, nfcAvailable: NFCReader.available,
                                 nfcReading: readingNFC, keyboardNames: keyboard.map { [$0] } ?? [],
                                 haptics: CHHapticEngine.capabilitiesForHardware().supportsHaptics, speaker: true)
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
