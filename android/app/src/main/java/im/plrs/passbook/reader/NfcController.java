package im.plrs.passbook.reader;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.os.Bundle;
import im.plrs.passbook.reader.protocol.VasReader;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class NfcController {
    public interface Listener {
        void read(VasReader.Read read);
        void error(String code);
    }
    private final Activity activity;
    private final Listener listener;
    private final NfcAdapter adapter;
    private final boolean readerFeatureSupported;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean reading = new AtomicBoolean();
    private volatile IsoDep active;
    private volatile int generation;
    private volatile boolean enabled;
    private boolean readerUnsupported;

    public NfcController(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        adapter = NfcAdapter.getDefaultAdapter(activity);
        readerFeatureSupported = adapter != null
            && activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_NFC);
    }

    public boolean supported() { return readerFeatureSupported && !readerUnsupported; }
    public boolean available() { return supported() && adapter.isEnabled(); }
    public boolean isReading() { return enabled && available(); }

    public void start(List<String> identifiers) {
        stop();
        if (!available()) return;
        enabled = true;
        int current = generation;
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        try {
            adapter.enableReaderMode(activity, tag -> discover(tag, identifiers, current),
                NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                    | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS, extras);
        } catch (UnsupportedOperationException exception) {
            readerUnsupported = true;
            enabled = false;
            listener.error("NFC_UNAVAILABLE");
        } catch (IllegalStateException | SecurityException exception) {
            enabled = false;
            listener.error("NFC_UNAVAILABLE");
        }
    }

    private void discover(Tag tag, List<String> ids, int current) {
        if (!reading.compareAndSet(false, true)) return;
        worker.execute(() -> {
            VasReader.Read result = null;
            String failure = null;
            IsoDep connection = IsoDep.get(tag);
            try {
                if (!enabled || current != generation) return;
                if (connection == null) throw new VasReader.ReadException("UNSUPPORTED_CARD");
                active = connection;
                connection.setTimeout(2500);
                connection.connect();
                if (!enabled || current != generation) return;
                result = new VasReader().read(connection::transceive, ids);
            } catch (VasReader.ReadException exception) { failure = exception.code; }
            catch (IOException exception) { failure = "TAP_LOST"; }
            catch (IllegalArgumentException exception) { failure = "INVALID_RESPONSE"; }
            finally {
                if (connection != null) {
                    try { connection.close(); }
                    catch (IOException exception) { if (failure == null) failure = "NFC_CLOSE_FAILED"; }
                }
                active = null;
                reading.set(false);
            }
            VasReader.Read read = result;
            String error = failure;
            activity.runOnUiThread(() -> {
                if (!enabled || current != generation) return;
                if (error != null) listener.error(error);
                else if (read != null) listener.read(read);
            });
        });
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
