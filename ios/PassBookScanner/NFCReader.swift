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
        let bytes = record.payload
        guard record.typeNameFormat == .nfcWellKnown, bytes.count > 1 else { return nil }
        let value: Data
        if record.type == Data([0x54]) {
            let languageLength = Int(bytes[0] & 0x3f)
            guard bytes.count > 1 + languageLength else { return nil }
            value = bytes.subdata(in: (1 + languageLength)..<bytes.count)
        } else if record.type == Data([0x55]) {
            let prefix = Int(bytes[0])
            guard prefix < uriPrefixes.count else { return nil }
            let suffix = bytes.dropFirst().map { String(UnicodeScalar($0)) }.joined()
            guard let data = (uriPrefixes[prefix] + suffix).data(using: .utf8) else { return nil }
            value = data
        } else { return nil }
        guard let text = String(data: value, encoding: .utf8), !text.isEmpty,
              text.utf8.count <= 2048,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return text
    }

    private nonisolated static let uriPrefixes = ["", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:"]
}
