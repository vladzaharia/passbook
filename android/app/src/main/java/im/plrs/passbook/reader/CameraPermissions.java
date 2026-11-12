package im.plrs.passbook.reader;

/** Runtime permission dialogs pause the Activity; grant only after it returns to the foreground. */
final class CameraPermissions {
    interface Request {
        Object token();
        boolean trusted();
        void grant();
        void deny();
    }
    private Request pending;
    private boolean foreground;
    private boolean allowed;

    // Android does not distinguish a first request from a permanent denial in
    // shouldShowRequestPermissionRationale. Do not guess when neither is known.
    static String state(boolean available, boolean restricted, boolean granted,
                        boolean rationale, boolean knownDenied) {
        if (!available) return "unavailable";
        if (restricted) return "restricted";
        if (granted) return "granted";
        if (rationale || knownDenied) return "denied";
        return "unknown";
    }

    void resume() { foreground = true; finish(); }
    void pause() { foreground = false; }
    void request(Request request, boolean alreadyAllowed) {
        cancel(); pending = request; allowed = alreadyAllowed; finish();
    }
    void result(boolean granted) {
        if (!granted) { cancel(); return; }
        allowed = true; finish();
    }
    void cancel(Object token) {
        if (pending != null && pending.token() == token) cancel();
    }
    void cancel() {
        Request request = pending;
        pending = null; allowed = false;
        if (request != null) request.deny();
    }
    private void finish() {
        if (!foreground || !allowed || pending == null) return;
        Request request = pending; pending = null;
        if (request.trusted()) request.grant();
        else request.deny();
    }
}
