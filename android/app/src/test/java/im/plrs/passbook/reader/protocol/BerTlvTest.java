package im.plrs.passbook.reader.protocol;

import static org.junit.Assert.*;
import java.util.Random;
import org.junit.Test;

public class BerTlvTest {
    @Test public void supportsShortAndLongLengths() {
        for (int length : new int[] {0, 1, 127, 128, 255}) {
            byte[] value = new byte[length];
            new Random(length).nextBytes(value);
            assertArrayEquals(value, BerTlv.require(BerTlv.encode(0x9f27, value), 0x9f27));
        }
    }
    @Test public void rejectsMalformedLengthsTagsAndDuplicateFields() {
        for (byte[] malformed : new byte[][] {{0x70}, {0x70, (byte) 0x80}, {0x70, (byte) 0x83, 0, 0, 0},
            {0x70, 3, 1}, {(byte) 0x9f}, {(byte) 0x9f, (byte) 0xff, (byte) 0xff, 1, 0}}) {
            assertThrows(IllegalArgumentException.class, () -> BerTlv.parse(malformed));
        }
        assertThrows(IllegalArgumentException.class, () -> BerTlv.require(new byte[] {0x50, 0, 0x50, 0}, 0x50));
        assertThrows(IllegalArgumentException.class, () -> BerTlv.parse(new byte[8193]));
    }
    @Test public void malformedInputNeverEscapesAsAnIndexException() {
        Random random = new Random(20261105);
        for (int i = 0; i < 10000; i++) {
            byte[] bytes = new byte[random.nextInt(128)]; random.nextBytes(bytes);
            try { BerTlv.parse(bytes); } catch (IllegalArgumentException expected) { /* Invalid frame. */ }
        }
    }
}
