import CoreNFC
import Foundation

@MainActor
final class NFCReader: NSObject, NFCNDEFReaderSessionDelegate {
    private static var current: NFCReader?
    private weak var owner: ScannerHardware?
    private var session: NFCNDEFReaderSession?

    static var available: Bool { NFCNDEFReaderSession.readingAvailable }

    static func start(owner: ScannerHardware) {
        guard available else { owner.onCancelled?(); return }
        current?.session?.invalidate()
        let reader = NFCReader(owner: owner)
        current = reader
        let session = NFCNDEFReaderSession(delegate: reader, queue: nil, invalidateAfterFirstRead: true)
        reader.session = session
        session.alertMessage = "Hold near a supported NFC tag."
        owner.setNFCReading(true)
        session.begin()
    }

    static func stop() {
        current?.session?.invalidate()
        current?.session = nil
        current = nil
    }

    private init(owner: ScannerHardware) { self.owner = owner }

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        Task { @MainActor in
            guard Self.current === self else { return }
            Self.current = nil
            self.session = nil
            self.owner?.setNFCReading(false)
            if let readerError = error as? NFCReaderError, readerError.code == .readerSessionInvalidationErrorUserCanceled { return }
            self.owner?.onCancelled?()
        }
    }

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        let text = messages.lazy.flatMap(\.records).compactMap(Self.decode).first
        Task { @MainActor in
            guard Self.current === self, let text else { return }
            Self.current = nil
            self.session = nil
            self.owner?.setNFCReading(false)
            self.owner?.onRead?(text, "nfc")
        }
    }

    private nonisolated static func decode(_ record: NFCNDEFPayload) -> String? {
        TagRecordParser.record(wellKnown: record.typeNameFormat == .nfcWellKnown, type: record.type, payload: record.payload, maxBytes: 2048)?.value
    }
}
