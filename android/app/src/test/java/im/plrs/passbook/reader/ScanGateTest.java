package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class ScanGateTest {
    private static String begin(ScanGate gate, String source, String payload, long now, boolean acks) {
        return gate.begin(source, payload, now, acks).id();
    }

    @Test public void legacyGateSerializesReadsAndAcceptsOneMatchingDecision() {
        ScanGate gate = new ScanGate();
        String id = begin(gate, "barcode", "a", 0, false);
        assertNotNull(id);
        assertEquals(ScanGate.Admit.BUSY, gate.begin("barcode", "b", 10, false).admit());
        assertFalse(gate.finish("other", 50));
        assertTrue(gate.finish(id, 50)); assertFalse(gate.finish(id, 60));
        assertEquals(ScanGate.Admit.DUPLICATE, gate.begin("barcode", "a", 1000, false).admit());
        assertNotNull(begin(gate, "barcode", "b", 1000, false));
    }

    @Test public void legacyTimeoutAndNavigationRejectLateDecisions() {
        ScanGate gate = new ScanGate(); String id = begin(gate, "barcode", "a", 0, false);
        assertFalse(gate.finish(id, 15000)); assertEquals(ScanGate.Expired.NO_VERDICT, gate.expire(15000));
        String second = begin(gate, "barcode", "b", 16000, false);
        assertFalse(gate.finish(id, 16001)); gate.reset(); assertFalse(gate.finish(second, 16002));
    }

    @Test public void acknowledgementFreesTheGateBeforeTheVerdict() {
        ScanGate gate = new ScanGate();
        String first = begin(gate, "barcode", "a", 0, true);
        assertEquals(ScanGate.Admit.BUSY, gate.begin("barcode", "b", 100, true).admit());
        assertTrue(gate.ack(first, 200));
        // A second distinct code while the first is still in review is forwarded.
        String second = begin(gate, "barcode", "b", 300, true);
        assertNotNull(second);
        assertTrue(gate.ack(second, 350));
        assertTrue(gate.finish(second, 60000)); assertTrue(gate.finish(first, 61000));
        assertFalse(gate.finish(first, 62000));
    }

    @Test public void missingAcknowledgementExpiresAfterTwoSecondsNotFifteen() {
        ScanGate gate = new ScanGate();
        String id = begin(gate, "barcode", "a", 0, true);
        assertEquals(ScanGate.Expired.NONE, gate.expire(1999));
        assertEquals(ScanGate.Expired.NO_ACK, gate.expire(2000));
        assertFalse(gate.ack(id, 2001));
        assertNotNull(begin(gate, "barcode", "b", 2001, true));
    }

    @Test public void duplicateIsPerSourceAndPerPayloadWithin1500ms() {
        ScanGate gate = new ScanGate();
        String id = begin(gate, "barcode", "a", 0, true); gate.ack(id, 1);
        assertEquals(ScanGate.Admit.DUPLICATE, gate.begin("barcode", "a", 1499, true).admit());
        assertEquals(ScanGate.Admit.OK, gate.begin("nfc-tag", "a", 1499, true).admit());
        gate.reset();
        assertEquals(ScanGate.Admit.OK, gate.begin("barcode", "a", 3000, true).admit());
    }

    @Test public void resetDropsAwaitingVerdicts() {
        ScanGate gate = new ScanGate();
        String id = begin(gate, "barcode", "a", 0, true); gate.ack(id, 1);
        gate.reset();
        assertFalse(gate.finish(id, 2));
    }

    @Test public void droppingReleasesAnAwaitedIdOnceAndResetForgetsIt() {
        ScanGate gate = new ScanGate();
        String first = begin(gate, "barcode", "a", 0, true);
        assertTrue(gate.ack(first, 100));
        assertTrue(gate.finish(first, 200)); assertFalse(gate.finish(first, 300));
        String second = begin(gate, "barcode", "b", 400, true);
        assertTrue(gate.ack(second, 450));
        gate.reset();
        assertFalse(gate.finish(second, 500));
    }
}
