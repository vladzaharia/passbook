package im.plrs.passbook.reader;

/** Bounds for the web's `haptic` op: at most 8 entries, each 0 to 500 ms, on/off alternating. */
final class Haptics {
    static final int MAX_ENTRIES = 8;
    static final int MAX_MS = 500;

    private Haptics() {}

    /** Waveform timings (a leading 0 ms off, then the pattern), or null when the pattern is not allowed. */
    static long[] timings(int[] pattern) {
        if (pattern == null || pattern.length == 0 || pattern.length > MAX_ENTRIES) return null;
        long[] out = new long[pattern.length + 1];
        for (int i = 0; i < pattern.length; i++) {
            if (pattern[i] < 0 || pattern[i] > MAX_MS) return null;
            out[i + 1] = pattern[i];
        }
        return out;
    }
}
