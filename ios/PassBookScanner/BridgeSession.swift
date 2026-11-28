import Foundation

/// The bridge handshake, with no WebKit types so the unit tests need no device.
/// The wire version and features come from the latest `hello` alone, so repeating a hello never changes
/// what the web and the app agree on.
struct BridgeHandshake: Equatable {
    enum Outgoing: Equatable { case ready, capabilities }

    /// Sent as a top-level `features` field of `ready` and `capabilities`, outside the snapshot object.
    static let advertisedFeatures = ["scanAck", "scanSettle"]

    private(set) var ready = false
    private(set) var wireVersion = 1
    private(set) var scanAck = false
    private var lastSnapshot: Data?

    /// Back to the state of a page that has not said hello. Called when a navigation starts.
    mutating func reset() { self = BridgeHandshake() }

    /// Applies a `hello`. The next snapshot goes out as `ready` whatever was sent before.
    mutating func hello(version: Int, versions: [Int]?, features: [String]?) {
        wireVersion = version == 2 && versions?.contains(2) == true ? 2 : 1
        scanAck = features?.contains("scanAck") == true
        ready = true
        lastSnapshot = nil
    }

    /// Whether a message with this version and op is for the current handshake. `hello` always is.
    func accepts(version: Int, op: String) -> Bool {
        op == "hello" || version == wireVersion
    }

    /// What to send for a snapshot: nothing before the handshake, `ready` for the first snapshot after a
    /// hello, `capabilities` for a change after that, nothing for a repeat.
    mutating func outgoing(snapshot: Data) -> Outgoing? {
        guard ready else { return nil }
        if lastSnapshot == nil { lastSnapshot = snapshot; return .ready }
        guard lastSnapshot != snapshot else { return nil }
        lastSnapshot = snapshot
        return .capabilities
    }
}

/// Serialises scans to the web. Every read is delivered or ends the read with an event; none vanishes.
/// With the `scanAck` feature the gate holds only until the web acknowledges the scan (2 s at most);
/// without it, until `result` (15 s at most), as before.
struct ScanGate {
    struct Item {
        let id: String
        let source: String
        /// Set for unsolicited reads; a read the web asked for (`tagRead`) is never a duplicate.
        let dedupeKey: String?
        let event: [String: Any]
    }

    enum Enqueue: Equatable { case queued, duplicate, full }

    static let dedupeWindow: TimeInterval = 1.5
    static let ackLimit: TimeInterval = 2
    static let resultLimit: TimeInterval = 15
    static let maxQueue = 8

    var ackEnabled = false
    private(set) var holding: String?
    private(set) var queue: [Item] = []
    private var recent: [String: TimeInterval] = [:]

    var holdLimit: TimeInterval { ackEnabled ? Self.ackLimit : Self.resultLimit }
    var isBusy: Bool { holding != nil || !queue.isEmpty }

    mutating func enqueue(_ item: Item, now: TimeInterval) -> Enqueue {
        recent = recent.filter { now - $0.value < Self.dedupeWindow }
        if let key = item.dedupeKey {
            if recent[key] != nil { return .duplicate }
            if queue.count >= Self.maxQueue { return .full }
            recent[key] = now
        } else if queue.count >= Self.maxQueue { return .full }
        queue.append(item)
        return .queued
    }

    /// The next item to send, when nothing is held.
    mutating func takeNext() -> Item? {
        guard holding == nil, !queue.isEmpty else { return nil }
        let item = queue.removeFirst()
        holding = item.id
        return item
    }

    /// An ack or a result for the held scan releases the gate. In ack mode only an ack does.
    mutating func release(id: String, byAck: Bool) -> Bool {
        guard holding == id, byAck == ackEnabled else { return false }
        holding = nil
        return true
    }

    /// The hold limit passed. True when the web should be told with a `timeout` event.
    mutating func expire(id: String) -> Bool {
        guard holding == id else { return false }
        holding = nil
        return !ackEnabled
    }

    /// Clears everything. Returns whether a scan was waiting, so the caller can end it with `cancelled`.
    mutating func reset() -> Bool {
        let waiting = isBusy
        holding = nil
        queue = []
        return waiting
    }
}

/// Repeated WebContent crashes stop the automatic reload and ask the operator.
struct CrashPolicy {
    enum Action: Equatable { case reload, askOperator }

    static let window: TimeInterval = 60
    static let limit = 3
    private var times: [TimeInterval] = []

    mutating func record(now: TimeInterval) -> Action {
        times = times.filter { now - $0 < Self.window } + [now]
        return times.count >= Self.limit ? .askOperator : .reload
    }

    mutating func reset() { times = [] }
}
