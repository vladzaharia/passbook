package im.plrs.passbook.reader;

/** At most {@code max} events in any {@code windowMs}; the rest are refused, not queued. */
final class RateLimit {
    private final long[] times;
    private final long windowMs;
    private int next;
    private int count;

    RateLimit(int max, long windowMs) { this.times = new long[max]; this.windowMs = windowMs; }

    synchronized boolean allow(long now) {
        if (count == times.length && now - times[next] < windowMs) return false;
        times[next] = now;
        next = (next + 1) % times.length;
        if (count < times.length) count++;
        return true;
    }
}
