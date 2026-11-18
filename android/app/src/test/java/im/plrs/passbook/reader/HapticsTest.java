package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class HapticsTest {
    @Test public void prependsAnOffAndKeepsTheOrder() {
        assertArrayEquals(new long[] {0, 40, 70, 40}, Haptics.timings(new int[] {40, 70, 40}));
    }
    @Test public void refusesEmptyLongOrOutOfRangePatterns() {
        assertNull(Haptics.timings(null));
        assertNull(Haptics.timings(new int[] {}));
        assertNull(Haptics.timings(new int[] {1, 1, 1, 1, 1, 1, 1, 1, 1}));
        assertNull(Haptics.timings(new int[] {501}));
        assertNull(Haptics.timings(new int[] {-1}));
        assertNotNull(Haptics.timings(new int[] {0, 500, 0, 500, 0, 500, 0, 500}));
    }
}
