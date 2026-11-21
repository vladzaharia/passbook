import XCTest
@testable import PassBookScanner

final class HardwareMapTests: XCTestCase {
    private func input(cameras: [HardwareMap.Camera] = [], permission: String = "granted", nfc: Bool = false,
                       reading: Bool = false, keyboards: [String] = [], haptics: Bool = false,
                       speaker: Bool = false) -> HardwareMap.Input {
        HardwareMap.Input(cameras: cameras, cameraPermission: permission, nfcAvailable: nfc, nfcReading: reading,
                          keyboardNames: keyboards, haptics: haptics, speaker: speaker)
    }
    private func kinds(_ entries: [[String: Any]]) -> [String] { entries.compactMap { $0["kind"] as? String } }

    func testLensesOfOneSideCollapse() {
        let cams = ["back", "back", "back", "front"].map { HardwareMap.Camera(facing: $0, name: "Camera") }
        let out = HardwareMap.entries(input(cameras: cams))
        XCTAssertEqual(kinds(out), ["camera", "camera"])
        XCTAssertEqual(out.compactMap { $0["facing"] as? String }, ["back", "front"])
        XCTAssertEqual(out[0]["builtIn"] as? Bool, true)
    }

    func testExternalCamerasAreKeptAndNotBuiltIn() {
        let cams = [HardwareMap.Camera(facing: "external", name: "USB"), HardwareMap.Camera(facing: "external", name: "USB 2")]
        let out = HardwareMap.entries(input(cameras: cams))
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0]["builtIn"] as? Bool, false)
    }

    func testCameraStateFollowsPermission() {
        let cams = [HardwareMap.Camera(facing: "back", name: "B")]
        XCTAssertEqual(HardwareMap.entries(input(cameras: cams, permission: "granted"))[0]["state"] as? String, "ready")
        XCTAssertEqual(HardwareMap.entries(input(cameras: cams, permission: "prompt"))[0]["state"] as? String, "needs-permission")
        XCTAssertEqual(HardwareMap.entries(input(cameras: cams, permission: "denied"))[0]["state"] as? String, "needs-permission")
        let blocked = HardwareMap.entries(input(cameras: cams, permission: "restricted"))[0]
        XCTAssertEqual(blocked["state"] as? String, "unavailable")
        XCTAssertNotNil(blocked["reason"])
    }

    func testNFCOnlyWhenAvailable() {
        XCTAssertEqual(kinds(HardwareMap.entries(input(nfc: false))), [])
        XCTAssertEqual(HardwareMap.entries(input(nfc: true))[0]["state"] as? String, "ready")
        XCTAssertEqual(HardwareMap.entries(input(nfc: true, reading: true))[0]["state"] as? String, "active")
    }

    func testKeyboardsHapticsSpeaker() {
        let out = HardwareMap.entries(input(keyboards: ["Wedge"], haptics: true, speaker: true))
        XCTAssertEqual(kinds(out), ["keyboard", "haptics", "speaker"])
        XCTAssertEqual(out[0]["connected"] as? Bool, true)
        XCTAssertEqual(out[0]["builtIn"] as? Bool, false)
    }

    func testBoundsApply() {
        let long = String(repeating: "x", count: 200)
        XCTAssertEqual((HardwareMap.entries(input(keyboards: [long]))[0]["name"] as? String)?.count, 80)
        let many = (0..<40).map { "k\($0)" }
        let out = HardwareMap.entries(input(keyboards: many))
        XCTAssertEqual(out.count, 16)
        XCTAssertTrue(out.allSatisfy { ($0["id"] as? String ?? "").count <= 64 })
    }
}
