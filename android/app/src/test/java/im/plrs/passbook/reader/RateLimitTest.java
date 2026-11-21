package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class RateLimitTest {
    @Test public void allowsFourPerSecondThenRecovers() {
        RateLimit limit = new RateLimit(4, 1000);
        for (int i = 0; i < 4; i++) assertTrue(limit.allow(i * 100));
        assertFalse(limit.allow(500)); assertFalse(limit.allow(999));
        assertTrue(limit.allow(1000));
        assertFalse(limit.allow(1050));
        assertTrue(limit.allow(1100));
    }
}
