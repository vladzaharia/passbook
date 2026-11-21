package im.plrs.passbook.reader;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Admits native reads to the web page.
 *
 * <p>With acknowledgements ({@code scanAck} advertised by the web) a read holds the gate only until the page
 * acknowledges receipt, at most {@link #ACK_MS}; its verdict is matched later without blocking further reads.
 * Without them (an older web) one read holds the gate until its verdict or {@link #VERDICT_MS}.
 * Either way the same payload from the same source inside {@link #DEDUPE_MS} is dropped; anything else is forwarded.
 */
public final class ScanGate {
    static final long ACK_MS = 2000;
    static final long VERDICT_MS = 15000;
    static final long DEDUPE_MS = 1500;
    private static final int MAX_AWAITING = 16;

    public enum Admit { OK, DUPLICATE, BUSY }
    public enum Expired { NONE, NO_ACK, NO_VERDICT }
    public record Begin(Admit admit, String id) {}

    private String pending;
    private long deadline;
    private boolean acks;
    private final Set<String> awaitingVerdict = new HashSet<>();
    private String lastSource;
    private String lastFingerprint;
    private long lastRead;

    public synchronized Begin begin(String source, String fingerprint, long now, boolean acknowledged) {
        if (pending != null && now < deadline) return new Begin(Admit.BUSY, null);
        if (source.equals(lastSource) && fingerprint.equals(lastFingerprint) && now - lastRead < DEDUPE_MS) {
            return new Begin(Admit.DUPLICATE, null);
        }
        pending = UUID.randomUUID().toString();
        acks = acknowledged;
        deadline = now + (acknowledged ? ACK_MS : VERDICT_MS);
        lastRead = now;
        lastSource = source;
        lastFingerprint = fingerprint;
        return new Begin(Admit.OK, pending);
    }

    /** The page has the read: free the gate and keep the id to match its verdict. */
    public synchronized boolean ack(String id, long now) {
        if (!acks || pending == null || !pending.equals(id) || now >= deadline) return false;
        pending = null;
        if (awaitingVerdict.size() >= MAX_AWAITING) awaitingVerdict.clear();
        awaitingVerdict.add(id);
        return true;
    }

    /** A verdict (or local capture) for a read this gate issued; true once per read. */
    public synchronized boolean finish(String id, long now) {
        if (awaitingVerdict.remove(id)) return true;
        if (acks || pending == null || !pending.equals(id) || now >= deadline) return false;
        pending = null;
        return true;
    }

    public synchronized Expired expire(long now) {
        if (pending == null || now < deadline) return Expired.NONE;
        pending = null;
        return acks ? Expired.NO_ACK : Expired.NO_VERDICT;
    }

    public synchronized void reset() { pending = null; awaitingVerdict.clear(); }
    public synchronized boolean busy(long now) { return pending != null && now < deadline; }
}
