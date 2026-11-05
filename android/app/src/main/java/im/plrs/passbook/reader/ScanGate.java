package im.plrs.passbook.reader;

import java.util.UUID;

/** One pending transaction; navigation, pause and timeout invalidate its result. */
public final class ScanGate {
    private String pending;
    private long deadline;
    private String lastFingerprint;
    private long lastRead;
    public synchronized String begin(String fingerprint, long now) {
        if (pending != null && now < deadline) return null;
        if (fingerprint.equals(lastFingerprint) && now - lastRead < 2000) return null;
        pending = UUID.randomUUID().toString();
        deadline = now + 15000;
        lastRead = now;
        lastFingerprint = fingerprint;
        return pending;
    }
    public synchronized boolean finish(String id, long now) {
        if (pending == null || !pending.equals(id) || now >= deadline) return false;
        pending = null;
        return true;
    }
    public synchronized boolean expire(long now) {
        if (pending == null || now < deadline) return false;
        pending = null;
        return true;
    }
    public synchronized void reset() { pending = null; }
    public synchronized boolean busy(long now) { return pending != null && now < deadline; }
}
