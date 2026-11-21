import Foundation

/// Pure mapping from what the OS reported to the bridge's `hardware` array. No AVFoundation or
/// GameController types, so the unit tests need no device. Ids are positional, never serials.
enum HardwareMap {
    struct Camera: Equatable, Sendable {
        let facing: String // front, back or external
        let name: String
    }

    struct Input: Equatable, Sendable {
        let cameras: [Camera]
        let cameraPermission: String
        let nfcAvailable: Bool
        let nfcReading: Bool
        let keyboardNames: [String]
        let haptics: Bool
        let speaker: Bool
    }

    static let maxEntries = 16
    static let maxName = 80

    static func entries(_ input: Input) -> [[String: Any]] {
        var out: [[String: Any]] = []
        // The wide, ultra-wide and telephoto lenses of one side are one camera to the operator.
        var seen = Set<String>()
        for camera in input.cameras where camera.facing == "external" || seen.insert(camera.facing).inserted {
            out.append(entry("camera", "camera-\(out.count)", name: camera.name, builtIn: camera.facing != "external",
                             state: cameraState(input.cameraPermission), facing: camera.facing))
        }
        if input.nfcAvailable {
            out.append(entry("nfc", "nfc", builtIn: true, state: input.nfcReading ? "active" : "ready"))
        }
        for (index, name) in input.keyboardNames.enumerated() {
            out.append(entry("keyboard", "keyboard-\(index)", name: name, builtIn: false, state: "ready"))
        }
        if input.haptics { out.append(entry("haptics", "haptics", builtIn: true, state: "ready")) }
        if input.speaker { out.append(entry("speaker", "speaker", builtIn: true, state: "ready")) }
        return Array(out.prefix(maxEntries))
    }

    static func cameraState(_ permission: String) -> String {
        switch permission {
        case "granted": "ready"
        case "restricted", "unavailable": "unavailable"
        default: "needs-permission"
        }
    }

    private static func entry(_ kind: String, _ id: String, name: String? = nil, builtIn: Bool, state: String,
                              facing: String? = nil) -> [String: Any] {
        var item: [String: Any] = ["kind": kind, "id": String(id.prefix(64)), "builtIn": builtIn,
                                   "connected": true, "state": state]
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            item["name"] = String(name.prefix(maxName))
        }
        if let facing { item["facing"] = facing }
        if state == "unavailable" && kind == "camera" { item["reason"] = "Camera is blocked or unavailable" }
        return item
    }
}
