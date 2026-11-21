package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class ReaderConfigTest {
    @Test public void normalizesOriginsWithExactHostAndPortBoundaries() {
        assertEquals("https://example.test", ReaderConfig.originOf("https://EXAMPLE.test:443/reader"));
        assertEquals("https://example.test:8443", ReaderConfig.originOf("https://example.test:8443/reader"));
        for (String value : List.of("http://example.test", "javascript:alert(1)", "https://example.test@evil.test", "https://example.test\\@evil.test")) {
            assertEquals("", ReaderConfig.originOf(value));
        }
    }
    @Test public void rejectsBadProfilesAndUntrustedVerifierUrls() {
        for (String url : List.of("http://example.test", "file:///test", "https://example.test/#token", ReaderConfig.HOME)) {
            assertThrows(IllegalArgumentException.class, () -> new ReaderConfig(url, List.of("pass.example"), "", ""));
        }
        assertThrows(IllegalArgumentException.class, () -> new ReaderConfig("", List.of("not-pass"), "", ""));
        assertThrows(IllegalArgumentException.class, () -> new ReaderConfig("", List.of("pass.a", "pass.a"), "", ""));
        assertThrows(IllegalArgumentException.class, () -> new ReaderConfig("", List.of("pass.a"), "android.intent.action.VIEW", "data"));
        assertEquals(List.of("pass.a", "pass.b"), ReaderConfig.parseIds(" pass.a\npass.b "));
    }
    @Test public void navigationStaysOnPassBookHostsAndTheConfiguredOrigin() {
        String configured = "https://verifier.example";
        for (String url : List.of("https://verifier.example/scan", "https://passbook.mobile/scan", "https://app.passbook.mobile:443/x",
            "https://wallet.plrs.im/p/1", ReaderConfig.HOME)) {
            assertTrue(url, ReaderConfig.allowsNavigation(url, configured));
        }
        for (String url : List.of("https://evil.example/", "https://passbook.mobile.evil.example/", "https://notpassbook.mobile/",
            "http://passbook.mobile/", "https://passbook.mobile@evil.example/", "intent://scan#Intent;end", "")) {
            assertFalse(url, ReaderConfig.allowsNavigation(url, configured));
        }
    }
}
