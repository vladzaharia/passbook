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
            let status = payload[payload.startIndex]
            let languageLength = Int(status & 0x3f)
            guard payload.count > 1 + languageLength else { return nil }
            kind = "T"
            let body = payload.subdata(in: (payload.startIndex + 1 + languageLength)..<payload.endIndex)
            // Bit 7 marks UTF-16, big endian unless a byte order mark says otherwise.
            if status & 0x80 != 0 {
                let hasBOM = body.starts(with: [0xFF, 0xFE]) || body.starts(with: [0xFE, 0xFF])
                guard let text = String(data: body, encoding: hasBOM ? .utf16 : .utf16BigEndian),
                      let utf8 = text.data(using: .utf8) else { return nil }
                value = utf8
            } else {
                value = body
            }
        } else if type == Data([0x55]) {
            let prefix = Int(payload[payload.startIndex])
            guard prefix < uriPrefixes.count else { return nil }
            guard let suffix = String(data: payload.dropFirst(), encoding: .utf8),
                  let data = (uriPrefixes[prefix] + suffix).data(using: .utf8) else { return nil }
            kind = "U"
            value = data
        } else { return nil }
        guard let text = String(data: value, encoding: .utf8), !text.isEmpty,
              text.utf8.count <= maxBytes,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return Record(type: kind, value: text)
    }
}
