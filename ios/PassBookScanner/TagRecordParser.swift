import Foundation

/// Pure helpers for tag reads. No CoreNFC types, so the unit tests need no device.
enum TagRecordParser {
    struct Record: Equatable, Sendable {
        let type: String
        let value: String
    }

    static let maxTagNDEFBytes = 1024
    private static let uriPrefixes = ["", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:"]

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02X", $0) }.joined()
    }

    /// The contract accepts 4, 7 or 10 byte UIDs.
    static func uidHex(_ uid: Data) -> String? {
        [4, 7, 10].contains(uid.count) ? hex(uid) : nil
    }

    /// A 4 byte UID starting 0x08 is a random ID; the server refuses it.
    static func isRandomUID(_ uid: Data) -> Bool {
        uid.count == 4 && uid.first == 0x08
    }

    /// The first well-known Text (`T`) or URI (`U`) record, or nil.
    static func record(wellKnown: Bool, type: Data, payload: Data, maxBytes: Int) -> Record? {
        guard wellKnown, payload.count > 1 else { return nil }
        let kind: String
        let value: Data
        if type == Data([0x54]) {
            let languageLength = Int(payload[payload.startIndex] & 0x3f)
            guard payload.count > 1 + languageLength else { return nil }
            kind = "T"
            value = payload.subdata(in: (payload.startIndex + 1 + languageLength)..<payload.endIndex)
        } else if type == Data([0x55]) {
            let prefix = Int(payload[payload.startIndex])
            guard prefix < uriPrefixes.count else { return nil }
            let suffix = payload.dropFirst().map { String(UnicodeScalar($0)) }.joined()
            guard let data = (uriPrefixes[prefix] + suffix).data(using: .utf8) else { return nil }
            kind = "U"
            value = data
        } else { return nil }
        guard let text = String(data: value, encoding: .utf8), !text.isEmpty,
              text.utf8.count <= maxBytes,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return Record(type: kind, value: text)
    }
}
