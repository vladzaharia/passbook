package im.plrs.passbook.reader.protocol;

import static org.junit.Assert.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public class NdefReaderTest {
    private static final byte[] OK = {(byte) 0x90, 0};

    private static byte[] ascii(String value) { return value.getBytes(StandardCharsets.US_ASCII); }
    private static byte[] shortRecord(int header, String type, byte[] payload) {
        return BerTlv.concat(new byte[] {(byte) header, (byte) type.length(), (byte) payload.length}, ascii(type), payload);
    }
    private static byte[] uriRecord(int code, String rest) {
        return shortRecord(0xd1, "U", BerTlv.concat(new byte[] {(byte) code}, ascii(rest)));
    }
    private static byte[] textRecord(String text) {
        return shortRecord(0xd1, "T", BerTlv.concat(new byte[] {2, 'e', 'n'}, ascii(text)));
    }

    /** NTAG-style memory: CC at page 3, one NDEF TLV from page 4. */
    private static VasReader.Channel type2(byte[] message) {
        byte[] memory = new byte[16 + 496];
        System.arraycopy(new byte[] {(byte) 0xe1, 0x10, 0x3e, 0}, 0, memory, 12, 4);
        byte[] tlv = BerTlv.concat(new byte[] {0, 3, (byte) message.length}, message, new byte[] {(byte) 0xfe});
        System.arraycopy(tlv, 0, memory, 16, tlv.length);
        return command -> {
            int offset = (command[1] & 255) * 4;
            if (command[0] != 0x30 || offset + 16 > memory.length) throw new IOException("NAK");
            return Arrays.copyOfRange(memory, offset, offset + 16);
        };
    }

    /** Type 4 tag: answers by command; selectApp is the status to the application SELECT. */
    private static VasReader.Channel type4(byte[] message, int mle, byte[] selectApp) {
        byte[] file = BerTlv.concat(new byte[] {(byte) (message.length >> 8), (byte) message.length}, message);
        byte[] cc = {0, 15, 0x20, (byte) (mle >> 8), (byte) mle, 0, (byte) 0xff, 4, 6, (byte) 0xe1, 4, 0x08, 0, 0, (byte) 0xff};
        boolean[] ccSelected = {false};
        return command -> {
            int instruction = command[1] & 255;
            if (instruction == 0xa4) {
                if (command[2] == 4) return selectApp;
                ccSelected[0] = command[5] == (byte) 0xe1 && command[6] == 3;
                return OK;
            }
            assertEquals(0xb0, instruction);
            int offset = (command[2] & 255) << 8 | (command[3] & 255), length = command[4] & 255;
            assertTrue("Le within MLe", length <= mle);
            byte[] source = ccSelected[0] ? cc : file;
            return BerTlv.concat(Arrays.copyOfRange(source, offset, Math.min(source.length, offset + length)), OK);
        };
    }

    @Test public void readsType2UriWithPrefixCode() throws Exception {
        NdefReader.Ndef ndef = NdefReader.readType2(type2(uriRecord(4, "example.com/t?x=1")));
        assertEquals(new NdefReader.Ndef("U", "https://example.com/t?x=1"), ndef);
    }

    @Test public void readsType2TextAndSkipsLockControlTlvs() throws Exception {
        NdefReader.Ndef ndef = NdefReader.readType2(type2(textRecord("badge 42")));
        assertEquals(new NdefReader.Ndef("T", "badge 42"), ndef);
    }

    @Test public void type2WithoutCapabilityContainerIsPlainTag() throws Exception {
        assertNull(NdefReader.readType2(command -> new byte[16]));
        assertThrows(IOException.class, () -> NdefReader.readType2(command -> { throw new IOException("lost"); }));
    }

    @Test public void readsType4UriAcrossChunks() throws Exception {
        byte[] message = uriRecord(3, "example.com/a/" + "x".repeat(60));
        NdefReader.Ndef ndef = NdefReader.readType4(type4(message, 16, OK));
        assertEquals(new NdefReader.Ndef("U", "http://example.com/a/" + "x".repeat(60)), ndef);
    }

    @Test public void readsType4Text() throws Exception {
        assertEquals(new NdefReader.Ndef("T", "hello"), NdefReader.readType4(type4(textRecord("hello"), 255, OK)));
    }

    @Test public void type4WithoutNdefApplicationIsPlainTag() throws Exception {
        assertNull(NdefReader.readType4(type4(uriRecord(0, "x"), 255, new byte[] {0x6a, (byte) 0x82})));
    }

    @Test public void vasSelectOn6a82FallsThroughToTagRead() throws Exception {
        VasReader.ReadException failure = assertThrows(VasReader.ReadException.class,
            () -> new VasReader().read(command -> new byte[] {0x6a, (byte) 0x82}, java.util.List.of("pass.example")));
        assertTrue(NdefReader.fallsThroughToTag(failure.code));
        assertFalse(NdefReader.fallsThroughToTag("AUTHENTICATION_REQUIRED"));
        assertFalse(NdefReader.fallsThroughToTag("PASS_NOT_FOUND"));
    }

    private static byte[] longUri(int length) {
        byte[] payload = BerTlv.concat(new byte[] {0}, ascii("a".repeat(length)));
        return BerTlv.concat(new byte[] {(byte) 0xc1, 1, 0, 0, (byte) (payload.length >> 8), (byte) payload.length}, ascii("U"), payload);
    }

    @Test public void valuesOver1024BytesAreNotReported() {
        assertNull(NdefReader.parse(longUri(1025)));
        assertEquals(1024, NdefReader.parse(longUri(1024)).value().length());
    }

    @Test public void parsesLongFormRecordsAndSkipsUnknownOnes() {
        byte[] other = shortRecord(0x91, "x", new byte[] {1});
        byte[] payload = BerTlv.concat(new byte[] {0}, ascii("tag"));
        byte[] last = BerTlv.concat(new byte[] {0x41, 1, 0, 0, 0, (byte) payload.length}, ascii("U"), payload);
        assertEquals(new NdefReader.Ndef("U", "tag"), NdefReader.parse(BerTlv.concat(other, last)));
        assertNull(NdefReader.parse(new byte[] {(byte) 0xd1, 1}));
        assertNull(NdefReader.parse(new byte[0]));
    }

    @Test public void formatsUidAsLowercaseHex() {
        assertEquals("04a2240bff6e80", NdefReader.hex(new byte[] {4, (byte) 0xa2, 0x24, 0x0b, (byte) 0xff, 0x6e, (byte) 0x80}));
        assertEquals("0801ab00", NdefReader.hex(new byte[] {8, 1, (byte) 0xab, 0}));
    }

    @Test public void flagsOnlyFourByteUidsStartingWith08AsRandom() {
        assertTrue(NdefReader.isRandomUid(new byte[] {8, 1, 2, 3}));
        assertFalse(NdefReader.isRandomUid(new byte[] {4, 1, 2, 3}));
        assertFalse(NdefReader.isRandomUid(new byte[] {8, 1, 2, 3, 4, 5, 6}));
        assertFalse(NdefReader.isRandomUid(new byte[] {8}));
    }
}
