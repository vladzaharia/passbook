package im.plrs.passbook.reader;

/**
 * Which bridge message may write the status line, and what it says.
 *
 * <p>A status write happens only for the read delivered last; older reads finish silently. {@code revise} also needs
 * that read to be the latest one answered. A page that settles haptics itself ({@code scanSettle}) owns the buzz.
 */
final class VerdictStatus {
    static final int NEUTRAL = 0xff34415d, GOOD = 0xff17683d, BAD = 0xff9d3025;

    /** {@code text == null} means the idle text. */
    record Write(String text, int color) {}

    private String lastDeliveredId, lastResultId;
    private boolean webSettle;

    /** A new page session: forget every id. */
    void hello(boolean settles) { webSettle = settles; clear(); }
    void clear() { lastDeliveredId = null; lastResultId = null; }
    void delivered(String id) { lastDeliveredId = id; }
    boolean buzzOnResult() { return !webSettle; }

    static boolean validOutcome(String outcome) {
        return "accepted".equals(outcome) || "rejected".equals(outcome) || "error".equals(outcome);
    }

    private static Write outcome(String outcome) {
        return new Write(outcome.equals("accepted") ? "Accepted" : outcome.equals("rejected") ? "Rejected" : "Unable to verify",
            outcome.equals("accepted") ? GOOD : BAD);
    }

    /** Call after the gate accepted the verdict. */
    Write result(String id, String outcome) {
        lastResultId = id;
        return id.equals(lastDeliveredId) ? outcome(outcome) : null;
    }

    /** Call after the gate released the id. Unknown reasons read as {@code closed}. */
    Write dropped(String id, String reason) {
        if (!id.equals(lastDeliveredId)) return null;
        if ("duplicate".equals(reason)) return new Write("Already scanned", NEUTRAL);
        if ("replaced".equals(reason)) return new Write("Skipped", NEUTRAL);
        return new Write(null, NEUTRAL);
    }

    Write revise(String id, String outcome) {
        if (!validOutcome(outcome) || !id.equals(lastResultId) || !id.equals(lastDeliveredId)) return null;
        return outcome(outcome);
    }
}
