package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class VerdictStatusTest {
    private static VerdictStatus two() {
        VerdictStatus status = new VerdictStatus();
        status.hello(true);
        status.delivered("A");
        status.delivered("B");
        return status;
    }

    @Test public void droppingAnOlderReadLeavesTheLatestStatus() {
        VerdictStatus status = two();
        assertNull(status.dropped("A", "duplicate"));
        assertNull(status.dropped("A", "closed"));
    }

    @Test public void droppedLatestReadsByReason() {
        VerdictStatus status = two();
        assertEquals("Already scanned", status.dropped("B", "duplicate").text());
        assertEquals("Skipped", status.dropped("B", "replaced").text());
        assertNull(status.dropped("B", "closed").text());
        assertNull(status.dropped("B", "other").text());
    }

    @Test public void resultForAnOlderReadWritesNothing() {
        VerdictStatus status = two();
        assertNull(status.result("A", "accepted"));
        assertEquals("Rejected", status.result("B", "rejected").text());
        assertEquals(VerdictStatus.BAD, status.result("B", "error").color());
    }

    @Test public void reviseAfterResultCorrectsOnlyTheLatestAnswered() {
        VerdictStatus status = two();
        assertNull(status.revise("B", "accepted"));
        status.result("B", "error");
        assertEquals("Accepted", status.revise("B", "accepted").text());
        assertEquals(VerdictStatus.GOOD, status.revise("B", "accepted").color());
        assertNull(status.revise("A", "accepted"));
        status.result("A", "accepted");
        assertEquals("Rejected", status.revise("B", "rejected").text());
    }

    @Test public void aLateResultForAnOlderReadKeepsTheLatestAnswered() {
        VerdictStatus status = two();
        status.result("B", "error");
        assertNull(status.result("A", "accepted"));
        assertNull(status.revise("A", "accepted"));
        assertEquals("Accepted", status.revise("B", "accepted").text());
    }

    @Test public void reviseWithAnUnknownOutcomeOrIdIsIgnored() {
        VerdictStatus status = two();
        status.result("B", "accepted");
        assertNull(status.revise("B", "maybe"));
        assertNull(status.revise("zzz", "rejected"));
    }

    @Test public void helloForgetsEveryId() {
        VerdictStatus status = two();
        status.result("B", "accepted");
        status.hello(false);
        assertNull(status.revise("B", "rejected"));
        assertNull(status.result("B", "accepted"));
        assertNull(status.dropped("B", "closed"));
    }

    @Test public void nativeBuzzOnlyWhenThePageDoesNotSettle() {
        VerdictStatus status = new VerdictStatus();
        status.hello(false);
        assertTrue(status.buzzOnResult());
        status.hello(true);
        assertFalse(status.buzzOnResult());
    }
}
