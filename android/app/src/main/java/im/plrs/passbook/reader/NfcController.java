package im.plrs.passbook.reader;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcB;
import android.os.Bundle;
import im.plrs.passbook.reader.protocol.NdefReader;
import im.plrs.passbook.reader.protocol.VasReader;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class NfcController {
    public interface Listener {
        void read(VasReader.Read read);
        void tag(NdefReader.Tag tag);
        void error(String code);
    }
    private final Activity activity;
    private final Listener listener;
    private final NfcAdapter adapter;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean reading = new AtomicBoolean();
    private volatile IsoDep active;
    private volatile int generation;
    private volatile boolean enabled;

    public NfcController(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        adapter = NfcAdapter.getDefaultAdapter(activity);
    }

    public boolean supported() {
        return adapter != null && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_NFC);
    }
    public boolean available() { return supported() && adapter.isEnabled(); }
    public boolean isReading() { return enabled && available(); }

    public void start(List<String> identifiers) { start(identifiers, true, false); }

    /** Wallet VAS and third-party tags share one reader mode; VAS goes first and 6A82 falls through to the tag. */
    public void start(List<String> identifiers, boolean vas, boolean tags) {
        stop();
        if (!available()) return;
        enabled = true;
        int current = generation;
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        try {
            adapter.enableReaderMode(activity, tag -> discover(tag, identifiers, vas, tags, current),
                NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                    | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS, extras);
        } catch (IllegalStateException | SecurityException | UnsupportedOperationException exception) {
            enabled = false;
            listener.error("NFC_UNAVAILABLE");
        }
    }

    private void discover(Tag tag, List<String> ids, boolean vas, boolean tags, int current) {
        if (!reading.compareAndSet(false, true)) return;
        worker.execute(() -> {
            VasReader.Read result = null;
            NdefReader.Tag found = null;
            String failure = null;
            IsoDep connection = IsoDep.get(tag);
            NfcA nfcA = NfcA.get(tag);
            try {
                if (!enabled || current != generation) return;
                if (vas && (!tags || (connection != null && !ids.isEmpty()))) {
                    try {
                        if (connection == null) throw new VasReader.ReadException("UNSUPPORTED_CARD");
                        active = connection;
                        connection.setTimeout(2500);
                        connection.connect();
                        if (!enabled || current != generation) return;
                        result = new VasReader().read(connection::transceive, ids);
                    } catch (VasReader.ReadException exception) {
                        if (!tags || !NdefReader.fallsThroughToTag(exception.code)) throw exception;
                    }
                }
                if (result == null && tags) found = readTag(tag, connection, nfcA, current);
            } catch (VasReader.ReadException exception) { failure = exception.code; }
            catch (IOException exception) { failure = "TAP_LOST"; }
            catch (RuntimeException exception) { failure = "INVALID_RESPONSE"; }
            finally {
                if (connection != null) {
                    try { connection.close(); }
                    catch (IOException exception) { if (failure == null) failure = "NFC_CLOSE_FAILED"; }
                }
                if (nfcA != null) {
                    try { nfcA.close(); }
                    catch (IOException exception) { if (failure == null) failure = "NFC_CLOSE_FAILED"; }
                }
                active = null;
                reading.set(false);
            }
            VasReader.Read read = result;
            NdefReader.Tag other = found;
            String error = failure;
            activity.runOnUiThread(() -> {
                if (!enabled || current != generation) return;
                if (error != null) listener.error(error);
                else if (read != null) listener.read(read);
                else if (other != null) listener.tag(other);
            });
        });
    }

    private NdefReader.Tag readTag(Tag tag, IsoDep isoDep, NfcA nfcA, int current) {
        byte[] id = tag.getId();
        if (id == null || !enabled || current != generation) return null;
        if (id.length != 4 && id.length != 7 && id.length != 10) throw new IllegalArgumentException("uid length");
        String tech = isoDep != null ? "isodep" : nfcA != null ? "a" : NfcB.get(tag) != null ? "b" : "unknown";
        NdefReader.Ndef ndef = null;
        try {
            if (isoDep != null) {
                if (!isoDep.isConnected()) { active = isoDep; isoDep.setTimeout(2500); isoDep.connect(); }
                ndef = NdefReader.readType4(isoDep::transceive);
            } else if (nfcA != null && nfcA.getSak() == 0) {
                active = null;
                nfcA.setTimeout(1000);
                nfcA.connect();
                ndef = NdefReader.readType2(nfcA::transceive);
            }
        } catch (IOException | IllegalArgumentException exception) {
            ndef = null; // The tag left mid-read: report what was read, the UID.
        }
        return new NdefReader.Tag(NdefReader.hex(id), NdefReader.isRandomUid(id), tech, ndef);
    }

    public void stop() {
        generation++;
        boolean wasEnabled = enabled;
        enabled = false;
        if (adapter != null && wasEnabled) {
            try { adapter.disableReaderMode(activity); }
            catch (IllegalStateException exception) { listener.error("NFC_UNAVAILABLE"); }
        }
        IsoDep connection = active;
        if (connection != null) {
            try { connection.close(); }
            catch (IOException exception) { listener.error("NFC_CLOSE_FAILED"); }
        }
    }
    public void destroy() { stop(); worker.shutdownNow(); }
}
