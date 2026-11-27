import XCTest
@testable import PassBookScanner

final class BridgeHandshakeTests: XCTestCase {
    private let snapshot = Data("a".utf8)

    func testNothingGoesOutBeforeHello() {
        var handshake = BridgeHandshake()
        XCTAssertNil(handshake.outgoing(snapshot: snapshot))
    }

    func testEveryHelloGetsReadyEvenWithTheSameSnapshot() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.outgoing(snapshot: snapshot), .ready)
        XCTAssertNil(handshake.outgoing(snapshot: snapshot))
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.outgoing(snapshot: snapshot), .ready)
    }

    func testHelloAfterASnapshotChangeStillGetsReady() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.outgoing(snapshot: snapshot), .ready)
        XCTAssertEqual(handshake.outgoing(snapshot: Data("b".utf8)), .capabilities)
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.outgoing(snapshot: Data("c".utf8)), .ready)
    }

    func testScanSettleIsAdvertised() {
        XCTAssertTrue(BridgeHandshake.advertisedFeatures.contains("scanSettle"))
        XCTAssertTrue(BridgeHandshake.advertisedFeatures.contains("scanAck"))
    }

    func testReviseDroppedAndV2HapticAreAcceptedAtV2() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: ["scanAck", "scanSettle"])
        for op in ["revise", "dropped", "haptic"] {
            XCTAssertTrue(handshake.accepts(version: 2, op: op))
        }
        XCTAssertFalse(handshake.accepts(version: 1, op: "revise"))
    }

    @MainActor func testV2HapticPatternsMapToFeedback() {
        XCTAssertEqual(ScannerViewController.hapticKind([100]), .system)
        XCTAssertEqual(ScannerViewController.hapticKind([100, 50, 100]), .warning)
        XCTAssertEqual(ScannerViewController.hapticKind([40]), .tap)
        XCTAssertEqual(ScannerViewController.hapticKind([40, 70, 40]), .warning)
        XCTAssertEqual(ScannerViewController.hapticKind([40, 70, 40, 70, 40]), .error)
        XCTAssertEqual(ScannerViewController.hapticKind([200]), .system)
        XCTAssertNil(ScannerViewController.hapticKind([]))
    }

    func testVersionFollowsTheLatestHelloOnly() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.wireVersion, 2)
        handshake.hello(version: 1, versions: nil, features: nil)
        XCTAssertEqual(handshake.wireVersion, 1)
        handshake.hello(version: 2, versions: [1], features: nil)
        XCTAssertEqual(handshake.wireVersion, 1)
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertEqual(handshake.wireVersion, 2)
    }

    func testOpsMustMatchTheWireVersionExceptHello() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertTrue(handshake.accepts(version: 2, op: "start"))
        XCTAssertFalse(handshake.accepts(version: 1, op: "start"))
        XCTAssertTrue(handshake.accepts(version: 1, op: "hello"))
    }

    func testScanAckFeatureComesFromTheHello() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: ["scanAck"])
        XCTAssertTrue(handshake.scanAck)
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        XCTAssertFalse(handshake.scanAck)
    }

    func testAdvertisesScanAckAndKeepsLegacyGateWithoutItInTheHello() {
        XCTAssertEqual(BridgeHandshake.advertisedFeatures, ["scanAck", "scanSettle"])
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: nil)
        var gate = ScanGate()
        gate.ackEnabled = handshake.scanAck
        XCTAssertEqual(gate.holdLimit, ScanGate.resultLimit)
    }

    func testResetReturnsToTheStateBeforeHello() {
        var handshake = BridgeHandshake()
        handshake.hello(version: 2, versions: [1, 2], features: ["scanAck"])
        handshake.reset()
        XCTAssertFalse(handshake.ready)
        XCTAssertEqual(handshake.wireVersion, 1)
        XCTAssertNil(handshake.outgoing(snapshot: snapshot))
    }
}

final class ScanGateTests: XCTestCase {
    private func item(_ id: String, key: String? = nil) -> ScanGate.Item {
        ScanGate.Item(id: id, source: "wedge", dedupeKey: key, event: ["id": id])
    }

    func testOneScanAtATimeUntilResultWithoutAck() {
        var gate = ScanGate()
        XCTAssertEqual(gate.enqueue(item("a"), now: 0), .queued)
        XCTAssertEqual(gate.enqueue(item("b"), now: 0), .queued)
        XCTAssertEqual(gate.takeNext()?.id, "a")
        XCTAssertNil(gate.takeNext())
        XCTAssertFalse(gate.release(id: "a", byAck: true))
        XCTAssertTrue(gate.release(id: "a", byAck: false))
        XCTAssertEqual(gate.takeNext()?.id, "b")
        XCTAssertEqual(gate.holdLimit, 15)
    }

    func testAckReleasesAndResultDoesNotInAckMode() {
        var gate = ScanGate()
        gate.ackEnabled = true
        _ = gate.enqueue(item("a"), now: 0)
        _ = gate.takeNext()
        XCTAssertFalse(gate.release(id: "a", byAck: false))
        XCTAssertFalse(gate.release(id: "other", byAck: true))
        XCTAssertTrue(gate.release(id: "a", byAck: true))
        XCTAssertEqual(gate.holdLimit, 2)
    }

    func testExpiryReleasesAndOnlyTellsTheWebWithoutAck() {
        var gate = ScanGate()
        _ = gate.enqueue(item("a"), now: 0)
        _ = gate.takeNext()
        XCTAssertTrue(gate.expire(id: "a"))
        XCTAssertNil(gate.holding)
        gate.ackEnabled = true
        _ = gate.enqueue(item("b"), now: 1)
        _ = gate.takeNext()
        XCTAssertFalse(gate.expire(id: "b"))
        XCTAssertNil(gate.holding)
        XCTAssertFalse(gate.expire(id: "b"))
    }

    func testSamePayloadWithin1500msIsDroppedLaterOnesAreNot() {
        var gate = ScanGate()
        XCTAssertEqual(gate.enqueue(item("a", key: "wedge|x"), now: 10), .queued)
        XCTAssertEqual(gate.enqueue(item("b", key: "wedge|x"), now: 11.4), .duplicate)
        XCTAssertEqual(gate.enqueue(item("c", key: "nfc|x"), now: 11.4), .queued)
        XCTAssertEqual(gate.enqueue(item("d", key: "wedge|y"), now: 11.4), .queued)
        XCTAssertEqual(gate.enqueue(item("e", key: "wedge|x"), now: 11.6), .queued)
    }

    func testRequestedReadsAreNeverDuplicates() {
        var gate = ScanGate()
        XCTAssertEqual(gate.enqueue(item("a"), now: 0), .queued)
        XCTAssertEqual(gate.enqueue(item("a"), now: 0.1), .queued)
    }

    func testAFullQueueSaysSoInsteadOfDroppingQuietly() {
        var gate = ScanGate()
        for index in 0..<ScanGate.maxQueue { XCTAssertEqual(gate.enqueue(item("\(index)", key: "k\(index)"), now: 0), .queued) }
        XCTAssertEqual(gate.enqueue(item("x", key: "kx"), now: 0), .full)
        XCTAssertEqual(gate.enqueue(item("y"), now: 0), .full)
    }

    func testResetReportsWaitingScans() {
        var gate = ScanGate()
        XCTAssertFalse(gate.reset())
        _ = gate.enqueue(item("a"), now: 0)
        XCTAssertTrue(gate.isBusy)
        XCTAssertTrue(gate.reset())
        XCTAssertFalse(gate.isBusy)
    }
}

final class CrashPolicyTests: XCTestCase {
    func testReloadsTwiceThenAsksTheOperator() {
        var policy = CrashPolicy()
        XCTAssertEqual(policy.record(now: 0), .reload)
        XCTAssertEqual(policy.record(now: 10), .reload)
        XCTAssertEqual(policy.record(now: 20), .askOperator)
    }

    func testOldCrashesAgeOutAndResetClears() {
        var policy = CrashPolicy()
        _ = policy.record(now: 0)
        _ = policy.record(now: 10)
        XCTAssertEqual(policy.record(now: 100), .reload)
        _ = policy.record(now: 101)
        XCTAssertEqual(policy.record(now: 102), .askOperator)
        policy.reset()
        XCTAssertEqual(policy.record(now: 103), .reload)
    }
}

final class NavigationPolicyTests: XCTestCase {
    private func decide(_ url: String, main: Bool = true, nilTarget: Bool = false, tap: Bool = false) -> NavigationPolicy.Decision {
        NavigationPolicy.decide(url: URL(string: url), isMainFrame: main, isTargetFrameNil: nilTarget, isLinkTap: tap)
    }

    func testMainFrameStaysOnPassBook() {
        XCTAssertEqual(decide("https://passbook.mobile/scan"), .allow)
        XCTAssertEqual(decide("https://evil.example/scan"), .openExternally)
        XCTAssertEqual(decide("https://passbook.mobile.evil.example/"), .openExternally)
        XCTAssertEqual(decide("http://passbook.mobile/scan"), .openExternally)
        XCTAssertEqual(decide("mailto:a@b.example"), .openExternally)
        XCTAssertEqual(decide("javascript:alert(1)"), .cancel)
        XCTAssertEqual(decide("file:///etc/passwd"), .cancel)
    }

    func testSubframesUseAnExplicitAllowlist() {
        XCTAssertEqual(decide("https://challenges.cloudflare.com/x", main: false), .allow)
        XCTAssertEqual(decide("https://passbook.mobile/x", main: false), .allow)
        XCTAssertEqual(decide("about:blank", main: false), .allow)
        XCTAssertEqual(decide("https://ads.example/x", main: false), .cancel)
        XCTAssertEqual(decide("http://challenges.cloudflare.com/x", main: false), .cancel)
    }

    func testNewWindowLinksOpenOutsideOnlyWhenTapped() {
        XCTAssertEqual(decide("https://example.com", main: false, nilTarget: true, tap: true), .openExternally)
        XCTAssertEqual(decide("https://example.com", main: false, nilTarget: true), .cancel)
    }
}
