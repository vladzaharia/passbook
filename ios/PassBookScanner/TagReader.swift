@preconcurrency import CoreNFC
import Foundation

struct TagReadResult: Sendable {
    let uid: String?
    let uidRandom: Bool
    let tech: String
    let ndef: TagRecordParser.Record?

    var wire: [String: Any] {
        var tag: [String: Any] = ["uidRandom": uidRandom, "tech": tech]
        if let uid { tag["uid"] = uid }
        if let ndef { tag["ndef"] = ["type": ndef.type, "value": ndef.value] }
        return tag
    }
}

/// One system sheet per read. iPhone and iPad read tags at desks only; there is no continuous mode.
@MainActor
final class TagReader: NSObject, NFCTagReaderSessionDelegate {
    private static var current: TagReader?
    private weak var owner: ScannerHardware?
    private var session: NFCTagReaderSession?
    private var timeout: Task<Void, Never>?
    private let id: String

    static var available: Bool { NFCTagReaderSession.readingAvailable }

    static func start(owner: ScannerHardware, id: String, prompt: String, timeoutMs: Int) {
        guard available else { owner.onCancelled?(); return }
        stop()
        let reader = TagReader(owner: owner, id: id)
        guard let session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: reader, queue: nil) else {
            owner.onCancelled?()
            return
        }
        current = reader
        reader.session = session
        session.alertMessage = prompt
        reader.timeout = Task { @MainActor [weak reader] in
            try? await Task.sleep(for: .milliseconds(timeoutMs))
            guard !Task.isCancelled else { return }
            reader?.session?.invalidate(errorMessage: "Timed out.")
        }
        owner.setNFCReading(true)
        session.begin()
    }

    static func cancel(id: String) {
        guard current?.id == id else { return }
        stop()
    }

    static func stop() {
        guard let reader = current else { return }
        reader.session?.invalidate()
        reader.finish()
        reader.owner?.setNFCReading(false)
    }

    private init(owner: ScannerHardware, id: String) {
        self.owner = owner
        self.id = id
    }

    private func finish() {
        timeout?.cancel()
        timeout = nil
        session = nil
        if Self.current === self { Self.current = nil }
    }

    nonisolated func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    nonisolated func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        Task { @MainActor in
            guard Self.current === self else { return }
            self.finish()
            self.owner?.setNFCReading(false)
            if let readerError = error as? NFCReaderError, readerError.code == .readerSessionInvalidationErrorUserCanceled { return }
            self.owner?.onCancelled?()
        }
    }

    nonisolated func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard tags.count == 1, let tag = tags.first else {
            session.alertMessage = "Hold one tag."
            session.restartPolling()
            return
        }
        nonisolated(unsafe) let identity: (uid: Data, tech: String, ndef: NFCNDEFTag)
        switch tag {
        case .miFare(let tag):
            identity = (tag.identifier, tag.mifareFamily == .desfire ? "isodep" : "a", tag)
        case .iso7816(let tag):
            identity = (tag.identifier, "isodep", tag)
        default:
            session.invalidate(errorMessage: "This tag type is not supported.")
            return
        }
        // Core NFC calls back on its own queue and its types are not Sendable.
        nonisolated(unsafe) let session = session
        session.connect(to: tag) { error in
            guard error == nil else { session.invalidate(errorMessage: "Could not read the tag."); return }
            Self.readNDEF(identity.ndef) { record in
                let uid = TagRecordParser.uidHex(identity.uid)
                guard uid != nil || record != nil else {
                    session.invalidate(errorMessage: "This tag type is not supported.")
                    return
                }
                let result = TagReadResult(uid: uid, uidRandom: TagRecordParser.isRandomUID(identity.uid), tech: identity.tech, ndef: record)
                Task { @MainActor in
                    guard Self.current === self else { return }
                    self.finish()
                    self.owner?.setNFCReading(false)
                    self.owner?.onTag?(self.id, result)
                }
                session.alertMessage = "Tag read."
                session.invalidate()
            }
        }
    }

    /// NDEF is optional: a UID-only tag has none, so a failed query or read yields nil.
    private nonisolated static func readNDEF(_ tag: NFCNDEFTag, _ done: @escaping @Sendable (TagRecordParser.Record?) -> Void) {
        nonisolated(unsafe) let tag = tag
        tag.queryNDEFStatus { status, _, error in
            guard error == nil, status != .notSupported else { done(nil); return }
            tag.readNDEF { message, error in
                let record = error == nil ? message?.records.lazy.compactMap {
                    TagRecordParser.record(wellKnown: $0.typeNameFormat == .nfcWellKnown, type: $0.type, payload: $0.payload, maxBytes: TagRecordParser.maxTagNDEFBytes)
                }.first : nil
                done(record)
            }
        }
    }
}
