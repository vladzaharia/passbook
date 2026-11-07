package im.plrs.passbook.reader;

import android.Manifest;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraManager;
import android.nfc.NfcAdapter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
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
import im.plrs.passbook.reader.protocol.VasReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity implements WebSurface.Listener, NfcController.Listener {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ScanGate gate = new ScanGate();
    private ReaderConfig config;
    private WebSurface web;
    private NfcController nfc;
    private CameraManager cameraManager;
    private TextView status;
    private Button scan;
    private boolean foreground;
    private boolean armed = true;
    private boolean registered;
    private boolean configuring;
    private boolean lastNfcAvailable;
    private final CameraPermissions cameraPermissions = new CameraPermissions();
    private final BroadcastReceiver barcodeReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (foreground && config.barcodeAction().equals(intent.getAction())) {
                barcode(intent.getStringExtra(config.barcodeExtra()));
            }
        }
    };
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
        @Override public void onCameraAvailable(String cameraId) {
            if (foreground) reportCapabilities();
        }
        @Override public void onCameraUnavailable(String cameraId) {
            if (foreground) reportCapabilities();
        }
    };
    private final Runnable expiry = new Runnable() {
        @Override public void run() {
            if (gate.expire(SystemClock.elapsedRealtime())) {
                notice("Unverified · no decision received");
                web.send(message("timeout"));
            }
            handler.postDelayed(this, 500);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        config = ReaderConfig.load(this);
        cameraManager = getSystemService(CameraManager.class);
        nfc = new NfcController(this, this);
        buildUi();
        web.load(config);
        handler.post(expiry);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
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
        settings.setOnClickListener(view -> {
            web.send(message("cancelled"));
            configuring = true; nfc.stop(); gate.reset(); reportCapabilities();
            SettingsDialog.show(this, config, next -> {
                unregisterBarcode(); config = next; registerBarcode(); web.load(next);
            }, () -> { configuring = false; resumeReader(); reportCapabilities(); });
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
        reload.setText(R.string.reload); reload.setOnClickListener(view -> web.load(config));
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
        resumeReader(); cameraPermissions.resume(); reportCapabilities();
    }
    @Override protected void onPause() {
        web.send(message("cancelled"));
        foreground = false; nfc.stop(); gate.reset(); unregisterBarcode(); unregisterReceiver(nfcReceiver);
        if (cameraManager != null) cameraManager.unregisterAvailabilityCallback(cameraAvailability);
        cameraPermissions.pause(); reportCapabilities();
        web.view.onPause(); super.onPause();
    }
    @Override protected void onDestroy() {
        cameraPermissions.cancel(); handler.removeCallbacksAndMessages(null); nfc.destroy(); web.destroy(); super.onDestroy();
    }
    @Override public void onBackPressed() {
        if (web.view.canGoBack()) web.view.goBack();
        else super.onBackPressed();
    }
    @Override public void reset() { cameraPermissions.cancel(); gate.reset(); nfc.stop(); }
    @Override public void notice(String text) { status.setTextColor(0xff34415d); status.setText(text); }

    private void resumeReader() {
        if (!foreground || !web.isReady() || !armed || configuring) nfc.stop();
        else nfc.start(config.passTypeIds());
        lastNfcAvailable = nfc.available();
        scan.setText(armed ? "Pause NFC" : "Start NFC");
        notice(!web.isReady() ? "Waiting for verifier connection" : !armed || configuring ? "NFC paused"
            : nfc.isReading() ? "Barcode ready · NFC capture unverified" : "NFC unavailable · barcode ready");
    }

    @Override public void command(JSONObject json) {
        if (json.optString("op").equals("hello")) {
            if (foreground) resumeReader();
            JSONObject ready = message("ready");
            put(ready, "nfc", nfc.available()); put(ready, "ecp", false);
            put(ready, "diagnostics", config.isLocal()); put(ready, "appVersion", BuildConfig.VERSION_NAME);
            put(ready, "capabilities", capabilities());
            web.send(ready); return;
        }
        if (!foreground) return;
        switch (json.optString("op")) {
            case "start": armed = true; resumeReader(); reportCapabilities(); break;
            case "stop": armed = false; resumeReader(); reportCapabilities(); break;
            case "captured":
                if (config.isLocal() && gate.finish(json.optString("id"), SystemClock.elapsedRealtime())) {
                    notice("Read captured · unverified");
                }
                break;
            case "result":
                String outcome = json.optString("outcome");
                if (config.isLocal() || !(outcome.equals("accepted") || outcome.equals("rejected") || outcome.equals("error"))) return;
                if (!gate.finish(json.optString("id"), SystemClock.elapsedRealtime())) return;
                notice(outcome.equals("accepted") ? "Accepted" : outcome.equals("rejected") ? "Rejected" : "Unable to verify");
                status.setTextColor(outcome.equals("accepted") ? 0xff17683d : 0xff9d3025);
                Vibrator vibrator = getSystemService(Vibrator.class);
                if (vibrator != null && vibrator.hasVibrator()) vibrator.vibrate(VibrationEffect.createOneShot(100, VibrationEffect.DEFAULT_AMPLITUDE));
                break;
            default: notice("Verifier requested an unsupported reader operation.");
        }
    }

    @Override public void read(VasReader.Read read) {
        JSONObject event = message("scan");
        put(event, "source", "apple-vas"); put(event, "passTypeIdentifier", read.passTypeIdentifier());
        put(event, "cryptogram", Base64.encodeToString(read.cryptogram(), Base64.NO_WRAP));
        deliver(event, fingerprint(read.cryptogram()));
    }

    void barcode(String value) {
        if (value == null || value.isEmpty() || value.length() > 2048 || value.chars().anyMatch(Character::isISOControl)) {
            notice("Invalid barcode. Scan it again."); return;
        }
        JSONObject event = message("scan"); put(event, "source", "barcode"); put(event, "value", value);
        deliver(event, fingerprint(value.getBytes(StandardCharsets.UTF_8)));
    }

    private void deliver(JSONObject event, String fingerprint) {
        if (!foreground || !web.isReady()) { notice("Connect the verifier before scanning."); return; }
        String id = gate.begin(fingerprint, SystemClock.elapsedRealtime());
        if (id == null) return;
        put(event, "id", id); put(event, "readAt", System.currentTimeMillis());
        status.setTextColor(0xff34415d);
        notice(config.isLocal() ? "Read captured · unverified" : "Checking…");
        if (!web.send(event)) { gate.reset(); notice("Verifier disconnected. Scan again."); }
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
        if (registered || config.barcodeAction().isEmpty() || !foreground) return;
        ContextCompat.registerReceiver(this, barcodeReceiver, new IntentFilter(config.barcodeAction()), ContextCompat.RECEIVER_EXPORTED);
        registered = true;
    }
    private void unregisterBarcode() {
        if (registered) { unregisterReceiver(barcodeReceiver); registered = false; }
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
        return capabilitySnapshot(BuildConfig.VERSION_NAME, cameraAvailable, permission,
            nfc.supported(), nfc.available(), nfc.isReading());
    }

    static JSONObject capabilitySnapshot(String version, boolean cameraAvailable, String cameraPermission,
                                         boolean nfcSupported, boolean nfcAvailable, boolean nfcReading) {
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
        put(nfc, "formats", formats); put(capabilities, "nfc", nfc);

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
        return capabilities;
    }

    private void reportCapabilities() {
        if (web == null || !web.isReady()) return;
        JSONObject event = message("capabilities");
        put(event, "capabilities", capabilities());
        web.send(event);
    }

    static JSONObject message(String event) {
        JSONObject json = new JSONObject(); put(json, "version", 1); put(json, "event", event); return json;
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
