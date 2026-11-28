package im.plrs.passbook.reader;

import android.Manifest;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.input.InputManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.view.InputDevice;
import android.nfc.NfcAdapter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.PermissionRequest;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import im.plrs.passbook.reader.protocol.NdefReader;
import im.plrs.passbook.reader.protocol.VasReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity implements WebSurface.Listener, NfcController.Listener {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ScanGate gate = new ScanGate();
    private final VerdictStatus verdicts = new VerdictStatus();
    private static final String DATAWEDGE_PROFILE = "PassBook Scanner";
    private static final String DATAWEDGE_COMMAND = "PASSBOOK_PROFILE";
    private static final int DATAWEDGE_PROFILE_VERSION = 2;
    private ReaderConfig config;
    private WebSurface web;
    private LinearLayout root;
    private int rendererLosses;
    private long firstRendererLoss;
    private NfcController nfc;
    private CameraManager cameraManager;
    private InputManager inputManager;
    private TextView status;
    private Button scan;
    private boolean foreground;
    private boolean armed = true;
    private boolean registered;
    private boolean configuring;
    private boolean lastNfcAvailable;
    private boolean vasOn = true;
    private boolean tagOn;
    private String oneShot;
    private final CameraPermissions cameraPermissions = new CameraPermissions();
    private final RateLimit broadcastLimit = new RateLimit(4, 1000);
    private final BroadcastReceiver barcodeReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            // Any app can send these (the vendor service is another app, so the receiver must be exported). They only
            // ever become a bounded, rate-limited barcode read, as if typed; registered only while resumed.
            if (!foreground || intent.getAction() == null) return;
            if (!broadcastLimit.allow(SystemClock.elapsedRealtime())) {
                Log.w("PassBook", "scan.broadcast_rate_limited");
                return;
            }
            try {
                if (Build.VERSION.SDK_INT >= 34 && getSentFromPackage() == null) {
                    Log.i("PassBook", "scan.broadcast_unattributed");
                }
                if (intent.getAction().equals(config.barcodeAction())) {
                    barcode(intent.getStringExtra(config.barcodeExtra()));
                    return;
                }
                for (Hardware.Vendor vendor : vendorsPresent()) {
                    if (vendor.action().equals(intent.getAction())) barcode(intent.getStringExtra(vendor.extra()));
                }
            } catch (RuntimeException malformed) {
                notice("Invalid barcode. Scan it again.");
            }
        }
    };
    private final BroadcastReceiver dataWedgeResult = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!DATAWEDGE_COMMAND.equals(intent.getStringExtra("COMMAND_IDENTIFIER"))) return;
            // API 34 names the sending package; a different one is not DataWedge answering.
            if (Build.VERSION.SDK_INT >= 34 && getSentFromPackage() != null
                && !Hardware.VENDORS.get(0).packages().contains(getSentFromPackage())) return;
            if ("SUCCESS".equals(intent.getStringExtra("RESULT"))) {
                getSharedPreferences("datawedge", MODE_PRIVATE).edit().putInt("profileVersion", DATAWEDGE_PROFILE_VERSION).apply();
                return;
            }
            Bundle info = intent.getBundleExtra("RESULT_INFO");
            Log.w("PassBook", "scan.datawedge_config_failed code=" + (info == null ? "unknown" : info.getString("RESULT_CODE")));
            notice("Zebra scanner setup failed. Use keyboard output.");
        }
    };
    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { hardwareChanged(); }
    };
    private final InputManager.InputDeviceListener inputListener = new InputManager.InputDeviceListener() {
        @Override public void onInputDeviceAdded(int deviceId) { hardwareChanged(); }
        @Override public void onInputDeviceRemoved(int deviceId) { hardwareChanged(); }
        @Override public void onInputDeviceChanged(int deviceId) { hardwareChanged(); }
    };
    private final Runnable hardwareReport = () -> { if (foreground) reportCapabilities(); };
    private final BroadcastReceiver nfcReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!foreground || !NfcAdapter.ACTION_ADAPTER_STATE_CHANGED.equals(intent.getAction())) return;
            boolean available = nfc.available();
            if (available == lastNfcAvailable) return;
            lastNfcAvailable = available;
            resumeReader(); reportCapabilities();
        }
    };
    private final CameraManager.AvailabilityCallback cameraAvailability = new CameraManager.AvailabilityCallback() {
        @Override public void onCameraAvailable(String cameraId) { if (foreground) hardwareChanged(); }
        @Override public void onCameraUnavailable(String cameraId) { if (foreground) hardwareChanged(); }
    };
    private final Runnable oneShotExpiry = () -> {
        if (oneShot == null) return;
        String expired = oneShot;
        oneShot = null;
        JSONObject ended = message("cancelled"); put(ended, "id", expired);
        web.send(ended); resumeReader(); reportCapabilities();
    };
    /** Runs only while a read holds the gate: until its acknowledgement, or its verdict on an older web. */
    private final Runnable expiry = new Runnable() {
        @Override public void run() {
            long now = SystemClock.elapsedRealtime();
            switch (gate.expire(now)) {
                case NO_VERDICT -> { notice("Unverified · no decision received"); web.send(message("timeout")); }
                case NO_ACK -> notice("Verifier did not respond. Scan again.");
                case NONE -> { }
            }
            if (gate.busy(now)) handler.postDelayed(this, 250);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        config = ReaderConfig.load(this);
        cameraManager = getSystemService(CameraManager.class);
        inputManager = getSystemService(InputManager.class);
        nfc = new NfcController(this, this);
        buildUi();
        web.load(config);
    }

    private void buildUi() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xfff5f4ef);
        int padding = dp(12);
        root.setPadding(padding, 0, padding, 0);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(padding, insets.getSystemWindowInsetTop(), padding, insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout header = new LinearLayout(this);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText(R.string.app_name); title.setTextSize(20); title.setTextColor(0xff182136);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(56), 1));
        Button settings = new Button(this);
        settings.setText(R.string.settings); settings.setMinHeight(dp(48));
        settings.setContentDescription("Settings. Press and hold to open.");
        // Press and hold: a held-out device cannot repoint the verifier by accident or by a passer-by.
        settings.setOnClickListener(view -> notice("Press and hold Settings to change them."));
        settings.setOnLongClickListener(view -> {
            web.send(message("cancelled"));
            configuring = true; endOneShot(); nfc.stop(); gate.reset(); verdicts.clear(); reportCapabilities();
            SettingsDialog.show(this, config, next -> {
                // A different origin starts clean: its cookies and storage are cleared and the bridge is re-bound to it.
                boolean moved = !next.origin().equals(config.origin());
                unregisterBarcode(); config = next; registerBarcode();
                if (moved) web.clearSiteData();
                web.load(next);
            }, () -> { configuring = false; resumeReader(); reportCapabilities(); });
            return true;
        });
        header.addView(settings);
        root.addView(header);
        status = new TextView(this);
        status.setTextSize(16); status.setMinHeight(dp(48)); status.setTextColor(0xff34415d);
        status.setGravity(android.view.Gravity.CENTER_VERTICAL);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status);
        LinearLayout actions = new LinearLayout(this);
        scan = new Button(this);
        scan.setText(R.string.pause_nfc);
        scan.setOnClickListener(view -> { armed = !armed; resumeReader(); reportCapabilities(); });
        actions.addView(scan, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button reload = new Button(this);
        reload.setText(R.string.reload); reload.setOnClickListener(view -> { rendererLosses = 0; web.load(config); });
        actions.addView(reload, new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(actions);
        EditText barcode = new EditText(this);
        barcode.setHint("Scan barcode here"); barcode.setContentDescription("Hardware barcode input");
        barcode.setSingleLine(true); barcode.setShowSoftInputOnFocus(false);
        barcode.setImeOptions(EditorInfo.IME_ACTION_GO);
        barcode.setOnKeyListener((view, keyCode, event) -> {
            if (keyCode != KeyEvent.KEYCODE_ENTER && keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) return false;
            if (event.getAction() == KeyEvent.ACTION_UP) {
                barcode(barcode.getText().toString()); barcode.setText("");
            }
            return true;
        });
        barcode.setOnEditorActionListener((input, action, event) -> {
            if (action == EditorInfo.IME_ACTION_GO || action == EditorInfo.IME_ACTION_DONE) {
                barcode(input.getText().toString()); input.setText("");
                return true;
            }
            return false;
        });
        root.addView(barcode, new LinearLayout.LayoutParams(-1, dp(56)));
        web = new WebSurface(this, this);
        root.addView(web.view, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        notice("Connecting reader…");
    }

    @Override protected void onResume() {
        super.onResume(); foreground = true; web.view.onResume(); registerBarcode();
        ContextCompat.registerReceiver(this, nfcReceiver, new IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED),
            ContextCompat.RECEIVER_EXPORTED);
        if (cameraManager != null) cameraManager.registerAvailabilityCallback(cameraAvailability, handler);
        if (inputManager != null) inputManager.registerInputDeviceListener(inputListener, handler);
        IntentFilter usb = new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        usb.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        usb.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        ContextCompat.registerReceiver(this, usbReceiver, usb, ContextCompat.RECEIVER_NOT_EXPORTED);
        resumeReader(); cameraPermissions.resume(); reportCapabilities();
    }
    @Override protected void onPause() {
        web.send(message("cancelled"));
        foreground = false; endOneShot(); nfc.stop(); gate.reset(); verdicts.clear(); handler.removeCallbacks(expiry); unregisterBarcode(); unregisterReceiver(nfcReceiver);
        if (cameraManager != null) cameraManager.unregisterAvailabilityCallback(cameraAvailability);
        if (inputManager != null) inputManager.unregisterInputDeviceListener(inputListener);
        unregisterReceiver(usbReceiver); handler.removeCallbacks(hardwareReport);
        cameraPermissions.pause(); reportCapabilities();
        web.view.onPause(); super.onPause();
    }
    @Override protected void onDestroy() {
        cameraPermissions.cancel(); handler.removeCallbacksAndMessages(null); nfc.destroy(); web.destroy(); super.onDestroy();
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration next) {
        super.onConfigurationChanged(next);
        // Rotation or a keyboard being attached no longer recreates the activity; only the hardware list can change.
        hardwareChanged();
    }
    @Override public void onBackPressed() {
        if (web.view.canGoBack()) web.view.goBack();
        else super.onBackPressed();
    }
    @Override public void reset() {
        cameraPermissions.cancel(); gate.reset(); verdicts.clear(); handler.removeCallbacks(expiry); endOneShot(); vasOn = true; tagOn = false; nfc.stop();
    }
    /** A killed renderer would otherwise take the whole app with it. Rebuild the surface; after three in a minute, wait for Reload. */
    @Override public void rendererGone(boolean crashed) {
        Log.w("PassBook", "scan.webview_renderer_gone crashed=" + crashed);
        long now = SystemClock.elapsedRealtime();
        if (rendererLosses == 0 || now - firstRendererLoss > 60000) { rendererLosses = 0; firstRendererLoss = now; }
        rendererLosses++;
        int index = root.indexOfChild(web.view);
        root.removeView(web.view);
        web.destroy();
        web = new WebSurface(this, this);
        root.addView(web.view, Math.max(index, 0), new LinearLayout.LayoutParams(-1, 0, 1));
        if (foreground) web.view.onResume();
        if (rendererLosses >= 3) { notice("Verifier keeps stopping. Press Reload."); return; }
        web.load(config);
        notice("Verifier restarted");
    }

    @Override public void external(android.net.Uri url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (android.content.ActivityNotFoundException none) { notice("No browser to open that link."); }
    }
    @Override public void notice(String text) { status.setTextColor(0xff34415d); status.setText(text); }

    private void endOneShot() { oneShot = null; handler.removeCallbacks(oneShotExpiry); }

    private void resumeReader() {
        boolean vas = armed && vasOn, tags = (armed && tagOn) || oneShot != null;
        if (!foreground || !web.isReady() || configuring || !(vas || tags)) nfc.stop();
        else nfc.start(config.passTypeIds(), vas, tags);
        lastNfcAvailable = nfc.available();
        scan.setText(armed ? "Pause NFC" : "Start NFC");
        notice(idleText());
    }

    private String idleText() {
        return !web.isReady() ? "Waiting for verifier connection" : !armed || configuring ? "NFC paused"
            : nfc.isReading() ? "Barcode ready · NFC capture unverified" : "NFC unavailable · barcode ready";
    }

    private void write(VerdictStatus.Write write) {
        if (write == null) return;
        notice(write.text() == null ? idleText() : write.text());
        status.setTextColor(write.color());
    }

    @Override public void command(JSONObject json) {
        if (json.optString("op").equals("hello")) {
            endOneShot(); vasOn = true; tagOn = false; armed = false;
            gate.reset(); verdicts.hello(web.feature("scanSettle"));
            if (foreground) resumeReader();
            JSONObject ready = message("ready");
            put(ready, "nfc", nfc.available()); put(ready, "ecp", false);
            put(ready, "diagnostics", config.isLocal()); put(ready, "appVersion", BuildConfig.VERSION_NAME);
            put(ready, "capabilities", capabilities()); put(ready, "features", features());
            web.send(ready); return;
        }
        if (!foreground) return;
        switch (json.optString("op")) {
            case "start": case "stop": startStop(json); break;
            case "tagRead": tagRead(json); break;
            case "tagCancel":
                if (web.version() == 2 && oneShot != null && oneShot.equals(json.optString("id"))) {
                    endOneShot(); resumeReader(); reportCapabilities();
                }
                break;
            case "scanAck": gate.ack(json.optString("id"), SystemClock.elapsedRealtime()); break;
            case "captured":
                if (config.isLocal() && gate.finish(json.optString("id"), SystemClock.elapsedRealtime())) {
                    notice("Read captured · unverified");
                }
                break;
            case "result":
                String outcome = json.optString("outcome");
                if (config.isLocal() || !VerdictStatus.validOutcome(outcome)) return;
                String resultId = json.optString("id");
                if (!gate.finish(resultId, SystemClock.elapsedRealtime())) return;
                write(verdicts.result(resultId, outcome));
                Vibrator vibrator = getSystemService(Vibrator.class);
                if (verdicts.buzzOnResult() && vibrator != null && vibrator.hasVibrator()) {
                    vibrator.vibrate(VibrationEffect.createOneShot(100, VibrationEffect.DEFAULT_AMPLITUDE));
                }
                break;
            case "dropped":
                if (config.isLocal() || !web.feature("scanSettle")) return;
                String droppedId = json.optString("id");
                if (!gate.finish(droppedId, SystemClock.elapsedRealtime())) return;
                write(verdicts.dropped(droppedId, json.optString("reason")));
                break;
            case "revise":
                if (config.isLocal() || !web.feature("scanSettle")) return;
                write(verdicts.revise(json.optString("id"), json.optString("outcome")));
                break;
            case "haptic":
                JSONArray pattern = json.optJSONArray("pattern");
                int[] values = pattern == null ? null : new int[pattern.length()];
                for (int i = 0; values != null && i < values.length; i++) values[i] = pattern.optInt(i, -1);
                long[] timings = Haptics.timings(values);
                Vibrator buzz = getSystemService(Vibrator.class);
                if (timings != null && buzz != null && buzz.hasVibrator()) buzz.vibrate(VibrationEffect.createWaveform(timings, -1));
                break;
            // iOS-only operations: nothing to do here, and nothing to tell the operator.
            case "nfcRead": case "customerStatus": case "customerBranding": break;
            default: notice("Verifier requested an unsupported reader operation.");
        }
    }

    /** v2 start/stop name the formats to read; without them (and on v1) they mean wallet-vas, as before. */
    private void startStop(JSONObject json) {
        boolean start = json.optString("op").equals("start");
        JSONArray formats = web.version() == 2 ? json.optJSONArray("formats") : null;
        if (formats == null) {
            armed = start; vasOn = true; tagOn = false;
        } else {
            boolean vas = false, tags = false;
            for (int index = 0; index < formats.length(); index++) {
                vas |= formats.optString(index).equals("wallet-vas");
                tags |= formats.optString(index).equals("tag");
            }
            if (start) { armed = true; vasOn = vas; tagOn = tags; }
            else { vasOn &= !vas; tagOn &= !tags; armed = vasOn || tagOn; }
        }
        resumeReader(); reportCapabilities();
    }

    private void tagRead(JSONObject json) {
        long timeout = json.optLong("timeoutMs");
        String id = json.optString("id");
        if (web.version() != 2 || id.isEmpty() || id.length() > 64 || timeout < 1 || timeout > 60000) return;
        endOneShot();
        oneShot = id;
        handler.postDelayed(oneShotExpiry, timeout);
        resumeReader(); reportCapabilities();
    }

    @Override public void tag(NdefReader.Tag tag) {
        if (web.version() != 2) return;
        JSONObject read = new JSONObject();
        put(read, "uid", tag.uid()); put(read, "uidRandom", tag.uidRandom()); put(read, "tech", tag.tech());
        String data = tag.uid();
        if (tag.ndef() != null) {
            JSONObject ndef = new JSONObject();
            put(ndef, "type", tag.ndef().type()); put(ndef, "value", tag.ndef().value());
            put(read, "ndef", ndef);
            data += ":" + tag.ndef().type() + ":" + tag.ndef().value();
        }
        JSONObject event = message("scan");
        put(event, "source", "nfc-tag"); put(event, "tag", read);
        // The gate drops the same tag read again within two seconds.
        boolean sent = deliver(event, fingerprint(data.getBytes(StandardCharsets.UTF_8)));
        if (oneShot != null) {
            endOneShot();
            if (!sent) web.send(message("cancelled"));
            resumeReader(); reportCapabilities();
        }
    }

    @Override public void read(VasReader.Read read) {
        JSONObject event = message("scan");
        put(event, "source", "apple-vas"); put(event, "passTypeIdentifier", read.passTypeIdentifier());
        put(event, "cryptogram", Base64.encodeToString(read.cryptogram(), Base64.NO_WRAP));
        deliver(event, fingerprint(read.cryptogram()));
    }

    void barcode(String value) {
        if (!Hardware.validBarcode(value)) {
            notice("Invalid barcode. Scan it again."); return;
        }
        JSONObject event = message("scan"); put(event, "source", "barcode"); put(event, "value", value);
        deliver(event, fingerprint(value.getBytes(StandardCharsets.UTF_8)));
    }

    private boolean deliver(JSONObject event, String fingerprint) {
        if (!foreground || !web.isReady()) { notice("Connect the verifier before scanning."); return false; }
        boolean acks = web.feature("scanAck") && !config.isLocal();
        ScanGate.Begin begin = gate.begin(event.optString("source"), fingerprint, SystemClock.elapsedRealtime(), acks);
        if (begin.admit() == ScanGate.Admit.BUSY) { notice("Finish the current scan first."); return false; }
        if (begin.admit() == ScanGate.Admit.DUPLICATE) return false;
        handler.removeCallbacks(expiry); handler.postDelayed(expiry, 250);
        put(event, "id", begin.id()); put(event, "readAt", System.currentTimeMillis());
        verdicts.delivered(begin.id());
        status.setTextColor(0xff34415d);
        notice(config.isLocal() ? "Read captured · unverified" : "Checking…");
        if (!web.send(event)) { gate.reset(); notice("Verifier disconnected. Scan again."); return false; }
        return true;
    }

    @Override public void error(String code) {
        if (gate.busy(SystemClock.elapsedRealtime())) return;
        notice(switch (code) {
            case "AUTHENTICATION_REQUIRED" -> "Open Wallet and authenticate, then tap again.";
            case "PASS_NOT_FOUND" -> "No matching pass. Check the configured Pass Type IDs.";
            case "TAP_LOST" -> "Hold the phone steady and tap again.";
            case "UNSUPPORTED_CARD", "UNSUPPORTED_WALLET" -> "Present an NFC-enabled Apple Wallet pass.";
            default -> "Reader error (" + code + "). Tap again.";
        });
    }

    private void registerBarcode() {
        List<Hardware.Vendor> vendors = vendorsPresent();
        if (registered || !foreground || (config.barcodeAction().isEmpty() && vendors.isEmpty())) return;
        Hardware.Registration registration = Hardware.registration(config.barcodeAction(), vendors);
        IntentFilter filter = new IntentFilter();
        for (String action : registration.actions()) filter.addAction(action);
        for (String category : registration.categories()) filter.addCategory(category);
        if (vendors.stream().anyMatch(vendor -> vendor.name().equals("zebra"))) configureDataWedge();
        ContextCompat.registerReceiver(this, barcodeReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
        IntentFilter result = new IntentFilter("com.symbol.datawedge.api.RESULT_ACTION");
        result.addCategory(Intent.CATEGORY_DEFAULT);
        ContextCompat.registerReceiver(this, dataWedgeResult, result, ContextCompat.RECEIVER_EXPORTED);
        registered = true;
    }
    /**
     * Creates this app's own DataWedge profile once (version 2 updates v1): barcode input and broadcast intent
     * output, with keystroke output off so one scan is not delivered twice. The result is requested; the flag is
     * stored only on success, so a failure retries on the next resume.
     */
    private void configureDataWedge() {
        SharedPreferences prefs = getSharedPreferences("datawedge", MODE_PRIVATE);
        int done = prefs.getInt("profileVersion", 0);
        if (done >= DATAWEDGE_PROFILE_VERSION) return;
        Hardware.Vendor zebra = Hardware.VENDORS.get(0);
        Bundle barcodeParams = new Bundle();
        barcodeParams.putString("scanner_input_enabled", "true");
        Bundle intentParams = new Bundle();
        intentParams.putString("intent_output_enabled", "true"); intentParams.putString("intent_action", zebra.action());
        intentParams.putString("intent_delivery", "2");
        // The intent path is the one in use, so DataWedge must not also type the scan into the focused field.
        Bundle keystrokeParams = new Bundle();
        keystrokeParams.putString("keystroke_output_enabled", "false");
        ArrayList<Bundle> plugins = new ArrayList<>();
        String[] names = {"BARCODE", "INTENT", "KEYSTROKE"};
        Bundle[] params = {barcodeParams, intentParams, keystrokeParams};
        for (int i = 0; i < names.length; i++) {
            Bundle plugin = new Bundle();
            plugin.putString("PLUGIN_NAME", names[i]); plugin.putBundle("PARAM_LIST", params[i]); plugins.add(plugin);
        }
        Bundle app = new Bundle();
        app.putString("PACKAGE_NAME", getPackageName()); app.putStringArray("ACTIVITY_LIST", new String[] {"*"});
        Bundle main = new Bundle();
        main.putString("PROFILE_NAME", DATAWEDGE_PROFILE); main.putString("PROFILE_ENABLED", "true");
        main.putString("CONFIG_MODE", done == 0 ? "CREATE_IF_NOT_EXIST" : "UPDATE");
        main.putParcelableArrayList("PLUGIN_CONFIG", plugins); main.putParcelableArray("APP_LIST", new Bundle[] {app});
        Intent request = new Intent("com.symbol.datawedge.api.ACTION").setPackage(zebra.packages().get(0));
        request.putExtra("com.symbol.datawedge.api.SET_CONFIG", main);
        request.putExtra("SEND_RESULT", "LAST_RESULT"); request.putExtra("COMMAND_IDENTIFIER", DATAWEDGE_COMMAND);
        sendBroadcast(request);
    }

    private void unregisterBarcode() {
        if (registered) { unregisterReceiver(barcodeReceiver); unregisterReceiver(dataWedgeResult); registered = false; }
    }

    @Override public void camera(PermissionRequest request) {
        if (!foreground || !web.trusted(web.view.getUrl())
            || !Arrays.equals(request.getResources(), new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE})) {
            request.deny(); return;
        }
        boolean allowed = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        cameraPermissions.request(new CameraPermissions.Request() {
            public Object token() { return request; }
            public boolean trusted() {
                return web.trusted(request.getOrigin().toString()) && web.trusted(web.view.getUrl());
            }
            public void grant() { request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE}); }
            public void deny() { request.deny(); }
        }, allowed);
        if (!allowed) requestPermissions(new String[] {Manifest.permission.CAMERA}, 10);
    }
    @Override public void cameraCancelled(PermissionRequest request) { cameraPermissions.cancel(request); }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == 10) {
            boolean granted = grants.length == 1 && grants[0] == PackageManager.PERMISSION_GRANTED;
            if (grants.length == 1) getSharedPreferences("camera-permission", MODE_PRIVATE).edit()
                .putBoolean("denied", !granted).apply();
            cameraPermissions.result(granted);
            reportCapabilities();
        }
    }

    private JSONObject capabilities() {
        PackageManager packages = getPackageManager();
        boolean cameraAvailable;
        try {
            cameraAvailable = cameraManager != null && cameraManager.getCameraIdList().length > 0;
        } catch (CameraAccessException | SecurityException exception) {
            // A built-in camera remains present even if the camera service cannot enumerate it.
            cameraAvailable = packages.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
        }
        boolean restricted = packages.isPermissionRevokedByPolicy(Manifest.permission.CAMERA, getPackageName());
        DevicePolicyManager policy = getSystemService(DevicePolicyManager.class);
        try {
            restricted |= policy != null && policy.getCameraDisabled(null);
        } catch (SecurityException ignored) {
            // Some managed profiles do not expose their camera policy to ordinary apps.
        }
        String permission = CameraPermissions.state(cameraAvailable, restricted,
            checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
            shouldShowRequestPermissionRationale(Manifest.permission.CAMERA),
            getSharedPreferences("camera-permission", MODE_PRIVATE).getBoolean("denied", false));
        JSONObject snapshot = capabilitySnapshot(BuildConfig.VERSION_NAME, cameraAvailable, permission,
            nfc.supported(), nfc.available(), nfc.isReading(), web != null && web.version() == 2);
        put(snapshot, "hardware", hardware(permission));
        return snapshot;
    }

    private String installSalt() {
        SharedPreferences prefs = getSharedPreferences("hardware", MODE_PRIVATE);
        String salt = prefs.getString("salt", null);
        if (salt == null) {
            salt = java.util.UUID.randomUUID().toString();
            prefs.edit().putString("salt", salt).apply();
        }
        return salt;
    }

    private void hardwareChanged() {
        handler.removeCallbacks(hardwareReport);
        handler.postDelayed(hardwareReport, 200);
    }

    private List<Hardware.Vendor> vendorsPresent() { return Hardware.present(installedVendorPackages()); }

    private Set<String> installedVendorPackages() {
        Set<String> found = new HashSet<>();
        PackageManager packages = getPackageManager();
        for (Hardware.Vendor vendor : Hardware.VENDORS) {
            if (!vendor.verified() && !config.unverifiedScanners()) continue;
            for (String name : vendor.packages()) {
                try { packages.getPackageInfo(name, 0); found.add(name); }
                catch (PackageManager.NameNotFoundException ignored) { /* not installed */ }
            }
        }
        return found;
    }

    private JSONArray hardware(String cameraPermission) {
        List<String> facings = new ArrayList<>();
        try {
            if (cameraManager != null) {
                for (String id : cameraManager.getCameraIdList()) {
                    Integer lens = cameraManager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                    facings.add(lens == null ? "external" : lens == CameraCharacteristics.LENS_FACING_FRONT ? "front"
                        : lens == CameraCharacteristics.LENS_FACING_BACK ? "back" : "external");
                }
            }
        } catch (CameraAccessException | SecurityException | IllegalArgumentException ignored) {
            // Report the cameras read so far; the camera field already covers a failed enumeration.
        }
        List<Hardware.Input> inputs = new ArrayList<>();
        Set<String> installed = installedVendorPackages();
        List<Hardware.Vendor> vendors = Hardware.present(installed);
        for (int id : InputDevice.getDeviceIds()) {
            InputDevice device = InputDevice.getDevice(id);
            if (device == null || (device.getSources() & InputDevice.SOURCE_KEYBOARD) != InputDevice.SOURCE_KEYBOARD
                || (device.getSources() & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD) continue;
            boolean alphabetic = device.getKeyboardType() == InputDevice.KEYBOARD_TYPE_ALPHABETIC;
            boolean external = Build.VERSION.SDK_INT >= 34 ? device.isExternal()
                : Hardware.externalBeforeApi34(device.getName(), device.getVendorId(), alphabetic, !vendors.isEmpty());
            inputs.add(new Hardware.Input(Hardware.stableId(device.getDescriptor(), installSalt()), device.getName(),
                device.getDescriptor(), true, external, device.isVirtual(), alphabetic));
        }
        List<String> usb = new ArrayList<>();
        UsbManager usbManager = getSystemService(UsbManager.class);
        if (usbManager != null) {
            for (UsbDevice device : usbManager.getDeviceList().values()) {
                if (device.getDeviceClass() == 9) continue; // hubs
                String product = device.getProductName();
                usb.add(product == null ? "USB device" : product);
            }
        }
        PackageManager packages = getPackageManager();
        Vibrator vibrator = getSystemService(Vibrator.class);
        return toJson(Hardware.build(new Hardware.Snapshot(facings, cameraPermission, nfc.supported(), nfc.available(),
            nfc.isReading(), inputs, installed, usb, bluetoothInputs(inputs),
            vibrator != null && vibrator.hasVibrator(), packages.hasSystemFeature(PackageManager.FEATURE_AUDIO_OUTPUT))));
    }

    /** Bonded Bluetooth keyboards and HID peripherals. Never asks for BLUETOOTH_CONNECT; empty when it is not granted. */
    private List<String> bluetoothInputs(List<Hardware.Input> inputs) {
        List<String> names = new ArrayList<>();
        if (Build.VERSION.SDK_INT < 31
            || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return names;
        try {
            BluetoothManager manager = getSystemService(BluetoothManager.class);
            if (manager == null || manager.getAdapter() == null) return names;
            for (BluetoothDevice device : manager.getAdapter().getBondedDevices()) {
                BluetoothClass type = device.getBluetoothClass();
                if (type != null && type.getMajorDeviceClass() == BluetoothClass.Device.Major.PERIPHERAL) {
                    String name = device.getName();
                    // A bonded keyboard-class device is already listed as an input device; do not list it twice.
                    boolean listed = name != null && inputs.stream().anyMatch(input -> name.equalsIgnoreCase(input.name()));
                    if (!listed) names.add(name == null ? "Bluetooth device" : name);
                }
            }
        } catch (SecurityException ignored) {
            // Permission revoked between the check and the call: list nothing.
        }
        return names;
    }

    static JSONArray toJson(List<Hardware.Entry> entries) {
        JSONArray array = new JSONArray();
        for (Hardware.Entry entry : entries) {
            JSONObject item = new JSONObject();
            put(item, "kind", entry.kind()); put(item, "id", entry.id());
            if (entry.name() != null) put(item, "name", entry.name());
            put(item, "builtIn", entry.builtIn());
            put(item, "connected", entry.connected() == null ? JSONObject.NULL : entry.connected());
            put(item, "state", entry.state());
            if (entry.facing() != null) put(item, "facing", entry.facing());
            if (entry.trigger() != null) put(item, "trigger", entry.trigger());
            if (entry.reason() != null) put(item, "reason", entry.reason());
            array.put(item);
        }
        return array;
    }

    /** Additive bridge features, a top-level event field outside the strict capability snapshot. */
    static JSONArray features() { return new JSONArray().put("scanAck").put("scanSettle"); }

    static JSONObject capabilitySnapshot(String version, boolean cameraAvailable, String cameraPermission,
                                         boolean nfcSupported, boolean nfcAvailable, boolean nfcReading) {
        return capabilitySnapshot(version, cameraAvailable, cameraPermission, nfcSupported, nfcAvailable, nfcReading, false);
    }

    /** With tags (wire v2) formats add tag-uid and tag-sun, and continuous says tags need no tagRead. */
    static JSONObject capabilitySnapshot(String version, boolean cameraAvailable, String cameraPermission,
                                         boolean nfcSupported, boolean nfcAvailable, boolean nfcReading, boolean tags) {
        JSONObject capabilities = new JSONObject();
        put(capabilities, "platform", "android");
        put(capabilities, "appVersion", version.length() <= 32 ? version : version.substring(0, 32));

        JSONObject camera = new JSONObject();
        put(camera, "available", cameraAvailable); put(camera, "permission", cameraPermission);
        put(capabilities, "camera", camera);

        JSONObject keyboard = new JSONObject();
        put(keyboard, "supported", true); put(keyboard, "connected", JSONObject.NULL);
        put(keyboard, "connectionObservable", false); put(capabilities, "keyboard", keyboard);

        JSONObject nfc = new JSONObject();
        boolean available = nfcSupported && nfcAvailable;
        put(nfc, "available", available); put(nfc, "reading", available && nfcReading);
        JSONArray formats = new JSONArray();
        if (nfcSupported) formats.put("wallet-vas");
        if (nfcSupported && tags) { formats.put("tag-uid"); formats.put("tag-sun"); }
        put(nfc, "formats", formats);
        if (tags) put(nfc, "continuous", nfcSupported);
        put(capabilities, "nfc", nfc);

        JSONObject vas = new JSONObject();
        put(vas, "deviceSupported", nfcSupported); put(vas, "available", false);
        put(vas, "reader", nfcSupported ? "android-native" : "none");
        put(vas, "reason", nfcSupported ? "Backend VAS verification is unavailable."
            : "This device does not support NFC reading.");
        put(capabilities, "vas", vas);

        JSONObject externalReader = new JSONObject();
        put(externalReader, "mode", "keyboard"); put(externalReader, "connected", JSONObject.NULL);
        put(capabilities, "externalReader", externalReader);

        JSONObject customerDisplay = new JSONObject();
        put(customerDisplay, "supported", false); put(customerDisplay, "available", false);
        put(customerDisplay, "active", false); put(capabilities, "customerDisplay", customerDisplay);
        put(capabilities, "haptics", true);
        return capabilities;
    }

    private void reportCapabilities() {
        if (web == null || !web.isReady()) return;
        JSONObject event = message("capabilities");
        put(event, "capabilities", capabilities()); put(event, "features", features());
        web.send(event);
    }

    private JSONObject message(String event) {
        JSONObject json = new JSONObject(); put(json, "version", web == null ? 1 : web.version()); put(json, "event", event); return json;
    }
    static void put(JSONObject json, String key, Object value) {
        try { json.put(key, value); }
        catch (JSONException exception) { throw new IllegalArgumentException("Invalid bridge message", exception); }
    }
    private static String fingerprint(byte[] value) {
        try { return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(value), Base64.NO_WRAP); }
        catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }
}
