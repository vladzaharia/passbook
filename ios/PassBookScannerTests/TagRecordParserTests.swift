import XCTest
@testable import PassBookScanner

final class TagRecordParserTests: XCTestCase {
    private func text(_ payload: [UInt8], max: Int = 1024) -> TagRecordParser.Record? {
        TagRecordParser.record(wellKnown: true, type: Data([0x54]), payload: Data(payload), maxBytes: max)
    }
    private func uri(_ payload: [UInt8], max: Int = 1024) -> TagRecordParser.Record? {
        TagRecordParser.record(wellKnown: true, type: Data([0x55]), payload: Data(payload), maxBytes: max)
    }

    func testHexIsUppercasePadded() {
        XCTAssertEqual(TagRecordParser.hex(Data([0x04, 0xA1, 0x0F, 0xFF])), "04A10FFF")
        XCTAssertEqual(TagRecordParser.hex(Data()), "")
    }

    func testUidLengths() {
        XCTAssertEqual(TagRecordParser.uidHex(Data([1, 2, 3, 4])), "01020304")
        XCTAssertNotNil(TagRecordParser.uidHex(Data(repeating: 1, count: 7)))
        XCTAssertNotNil(TagRecordParser.uidHex(Data(repeating: 1, count: 10)))
        XCTAssertNil(TagRecordParser.uidHex(Data(repeating: 1, count: 8)))
        XCTAssertNil(TagRecordParser.uidHex(Data()))
    }

    func testRandomUid() {
        XCTAssertTrue(TagRecordParser.isRandomUID(Data([0x08, 1, 2, 3])))
        XCTAssertFalse(TagRecordParser.isRandomUID(Data([0x04, 1, 2, 3])))
        XCTAssertFalse(TagRecordParser.isRandomUID(Data([0x08, 1, 2, 3, 4, 5, 6])))
    }

    func testTextRecordSkipsLanguageCode() {
        XCTAssertEqual(text([0x02, 0x65, 0x6E, 0x68, 0x69]), .init(type: "T", value: "hi"))
    }

    func testUriRecordExpandsPrefix() {
        XCTAssertEqual(uri([0x04] + Array("example.com/t".utf8)), .init(type: "U", value: "https://example.com/t"))
        XCTAssertEqual(uri([0x00] + Array("urn:x".utf8)), .init(type: "U", value: "urn:x"))
    }

    func testRejectsUnknownPrefixEmptyAndControlCharacters() {
        XCTAssertNil(uri([0x24, 0x61]))
        XCTAssertNil(uri([0x04]))
        XCTAssertNil(text([0x02, 0x65, 0x6E]))
        XCTAssertNil(text([0x02, 0x65, 0x6E, 0x61, 0x0A]))
    }

    func testRejectsOtherTypesAndFormats() {
        XCTAssertNil(TagRecordParser.record(wellKnown: true, type: Data([0x53, 0x70]), payload: Data([0, 1]), maxBytes: 1024))
        XCTAssertNil(TagRecordParser.record(wellKnown: false, type: Data([0x54]), payload: Data([0, 0x61]), maxBytes: 1024))
    }

    func testRespectsByteLimit() {
        let payload: [UInt8] = [0x00] + Array(repeating: 0x61, count: 1024)
        XCTAssertNotNil(text(payload))
        XCTAssertNil(text(payload + [0x61]))
        XCTAssertNotNil(text(payload + [0x61], max: 2048))
    }
}
