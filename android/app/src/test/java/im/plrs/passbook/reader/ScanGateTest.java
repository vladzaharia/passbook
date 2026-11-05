package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class ScanGateTest {
    @Test public void serializesReadsAndAcceptsOneMatchingDecision() {
        ScanGate gate = new ScanGate();
        String id = gate.begin("a", 0);
        assertNotNull(id); assertNull(gate.begin("b", 10));
        assertFalse(gate.finish("other", 50));
        assertTrue(gate.finish(id, 50)); assertFalse(gate.finish(id, 60));
        assertNull(gate.begin("a", 1000)); assertNotNull(gate.begin("b", 1000));
    }
    @Test public void timeoutAndNavigationRejectLateDecisions() {
        ScanGate gate = new ScanGate(); String id = gate.begin("a", 0);
        assertFalse(gate.finish(id, 15000)); assertTrue(gate.expire(15000));
        String second = gate.begin("b", 16000);
        assertFalse(gate.finish(id, 16001)); gate.reset(); assertFalse(gate.finish(second, 16002));
    }
}
