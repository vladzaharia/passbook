package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import im.plrs.passbook.reader.protocol.VasReader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ReaderInstrumentedTest {
    @Before public void resetConfig() {
        InstrumentationRegistry.getInstrumentation().getTargetContext()
            .getSharedPreferences("reader", 0).edit().clear().putString("url", "").commit();
        InstrumentationRegistry.getInstrumentation().getTargetContext()
            .getSharedPreferences("camera-permission", 0).edit().clear().commit();
    }

    @Test public void bundledDiagnosticsCapturesBarcodeAndVasWithoutAcceptingEither() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitPage(scenario);
            scenario.onActivity(activity -> activity.barcode("000123"));
            awaitJavascript(scenario, "document.querySelector('#read').textContent", "Barcode read");
            scenario.onActivity(activity -> activity.read(new VasReader.Read("pass.example.member", new byte[57])));
            awaitJavascript(scenario, "document.querySelector('#read').textContent", "Encrypted pass read");
            scenario.onActivity(activity -> {
                JSONObject forged = new JSONObject();
                MainActivity.put(forged, "op", "result"); MainActivity.put(forged, "outcome", "accepted");
                MainActivity.put(forged, "id", "unknown"); activity.command(forged);
                assertFalse(findText(activity.getWindow().getDecorView(), "Accepted"));
            });
        }
    }

    @Test public void capabilitySnapshotsDoNotClaimUnsupportedReadersOrVerification() throws Exception {
        JSONObject caps = MainActivity.capabilitySnapshot("1.2.3", true, "granted", true, true, true);
        assertEquals(8, caps.length());
        assertEquals("android", caps.getString("platform"));
        assertEquals("1.2.3", caps.getString("appVersion"));
        JSONObject camera = caps.getJSONObject("camera");
        assertEquals(2, camera.length());
        assertTrue(camera.getBoolean("available")); assertEquals("granted", camera.getString("permission"));
        JSONObject keyboard = caps.getJSONObject("keyboard");
        assertEquals(3, keyboard.length());
        assertTrue(keyboard.getBoolean("supported")); assertTrue(keyboard.isNull("connected"));
        assertFalse(keyboard.getBoolean("connectionObservable"));
        JSONObject nfc = caps.getJSONObject("nfc");
        assertEquals(3, nfc.length());
        assertTrue(nfc.getBoolean("available")); assertTrue(nfc.getBoolean("reading"));
        assertEquals(1, nfc.getJSONArray("formats").length());
        assertEquals("wallet-vas", nfc.getJSONArray("formats").getString(0));
        JSONObject vas = caps.getJSONObject("vas");
        assertEquals(4, vas.length());
        assertTrue(vas.getBoolean("deviceSupported")); assertFalse(vas.getBoolean("available"));
        assertEquals("android-native", vas.getString("reader"));
        assertTrue(vas.getString("reason").length() <= 240);
        JSONObject external = caps.getJSONObject("externalReader");
        assertEquals(2, external.length());
        assertEquals("keyboard", external.getString("mode")); assertTrue(external.isNull("connected"));
        JSONObject display = caps.getJSONObject("customerDisplay");
        assertEquals(3, display.length());
        assertFalse(display.getBoolean("supported")); assertFalse(display.getBoolean("available"));
        assertFalse(display.getBoolean("active"));

        JSONObject disabled = MainActivity.capabilitySnapshot("1", false, "unavailable", true, false, true);
        assertFalse(disabled.getJSONObject("nfc").getBoolean("available"));
        assertFalse(disabled.getJSONObject("nfc").getBoolean("reading"));
        assertTrue(disabled.getJSONObject("vas").getBoolean("deviceSupported"));
        assertFalse(disabled.getJSONObject("vas").getBoolean("available"));
        JSONObject absent = MainActivity.capabilitySnapshot("1", false, "unavailable", false, true, true);
        assertFalse(absent.getJSONObject("nfc").getBoolean("available"));
        assertFalse(absent.getJSONObject("nfc").getBoolean("reading"));
        assertEquals(0, absent.getJSONObject("nfc").getJSONArray("formats").length());
        assertFalse(absent.getJSONObject("vas").getBoolean("deviceSupported"));
        assertFalse(absent.getJSONObject("vas").getBoolean("available"));
        assertEquals("none", absent.getJSONObject("vas").getString("reader"));
        JSONObject longVersion = MainActivity.capabilitySnapshot("123456789012345678901234567890123456",
            false, "unavailable", false, false, false);
        assertEquals(32, longVersion.getString("appVersion").length());
        assertFalse(caps.toString().contains("cryptogram"));
        assertFalse(caps.toString().contains("passTypeIdentifier"));
    }

    @Test public void bridgeReportsCapabilitiesAtHandshakeAndLifecycleTransitions() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitPage(scenario);
            scenario.onActivity(activity -> findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                "window.reports=[];window.originalReaderHandler=PassBookNative.onmessage;"
                + "PassBookNative.onmessage=e=>{const m=JSON.parse(e.data);"
                + "if(m.event==='ready'||m.event==='capabilities')window.reports.push(m);"
                + "window.originalReaderHandler(e)};"
                + "PassBookNative.postMessage(JSON.stringify({version:1,op:'hello'}));", null));
            awaitJavascript(scenario,
                "window.reports.some(m=>m.event==='ready'&&m.version===1&&typeof m.nfc==='boolean'"
                + "&&m.ecp===false&&typeof m.diagnostics==='boolean'&&typeof m.appVersion==='string'"
                + "&&m.capabilities.platform==='android'&&m.capabilities.vas.available===false"
                + "&&m.capabilities.keyboard.connected===null)", "true");
            scenario.onActivity(activity -> findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                "window.beforeStop=window.reports.length;"
                + "PassBookNative.postMessage(JSON.stringify({version:1,op:'stop'}));", null));
            awaitJavascript(scenario,
                "window.reports.slice(window.beforeStop).some(m=>m.event==='capabilities'"
                + "&&m.capabilities.nfc.reading===false&&m.capabilities.vas.available===false)", "true");
            scenario.onActivity(activity -> findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                "window.beforeStart=window.reports.length;"
                + "PassBookNative.postMessage(JSON.stringify({version:1,op:'start'}));", null));
            awaitJavascript(scenario,
                "window.reports.slice(window.beforeStart).some(m=>m.event==='capabilities'"
                + "&&(!m.capabilities.nfc.reading||m.capabilities.nfc.available))", "true");
            scenario.onActivity(activity -> findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                "window.beforeResume=window.reports.length;window.resumeCheckpoint=true", null));
            awaitJavascript(scenario, "window.resumeCheckpoint", "true");
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitJavascript(scenario,
                "window.reports.slice(window.beforeResume).some(m=>m.event==='capabilities')", "true");
            scenario.onActivity(activity -> findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                "window.beforePermission=window.reports.length;window.permissionCheckpoint=true", null));
            awaitJavascript(scenario, "window.permissionCheckpoint", "true");
            AtomicInteger permission = new AtomicInteger();
            scenario.onActivity(activity -> {
                int current = activity.checkSelfPermission(android.Manifest.permission.CAMERA);
                permission.set(current);
                activity.onRequestPermissionsResult(10, new String[] {android.Manifest.permission.CAMERA},
                    new int[] {current});
            });
            String reported = permission.get() == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
            awaitJavascript(scenario,
                "window.reports.slice(window.beforePermission).some(m=>m.event==='capabilities'"
                + "&&['" + reported + "','unavailable','restricted'].includes(m.capabilities.camera.permission))",
                "true");
        }
    }

    @Test public void bridgeAcceptsMainFrameAndRejectsSameOriginChildAndOtherOrigins() throws Exception {
        AtomicInteger messages = new AtomicInteger();
        CountDownLatch childFinished = new CountDownLatch(1);
        AtomicReference<WebSurface> surface = new AtomicReference<>();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebSurface testWeb = new WebSurface(activity, new WebSurface.Listener() {
                    public void reset() {}
                    public void command(JSONObject message) { messages.incrementAndGet(); }
                    public void notice(String value) {}
                    public void camera(PermissionRequest request) { request.deny(); }
                });
                surface.set(testWeb);
                testWeb.view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                        boolean main = request.getUrl().getPath().equals("/reader");
                        String html = main
                            ? "<script>PassBookNative.postMessage(JSON.stringify({version:1,op:'hello'}))</script>"
                              + "<iframe src='/child'></iframe><iframe src='https://other.example/child'></iframe>"
                            : "<script>if(window.PassBookNative)PassBookNative.postMessage(JSON.stringify({version:1,op:'hello'}))</script>";
                        return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                    }
                    @Override public void onPageFinished(WebView web, String url) { childFinished.countDown(); }
                });
                activity.setContentView(testWeb.view);
                testWeb.load(new ReaderConfig("https://verifier.example/reader", List.of("pass.example.member"), "", ""));
            });
            assertTrue("Fixture did not load", childFinished.await(15, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertEquals("Only main-frame hello is allowed", 1, messages.get());
            scenario.onActivity(activity -> surface.get().destroy());
        }
    }

    @Test public void keyboardScannerWithEnterPreservesLeadingZeroes() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitPage(scenario);
            scenario.onActivity(activity -> {
                android.widget.EditText input = findInput(activity.getWindow().getDecorView());
                findWeb(activity.getWindow().getDecorView()).evaluateJavascript(
                    "const original=PassBookNative.onmessage;PassBookNative.onmessage=e=>{const m=JSON.parse(e.data);"
                    + "if(m.event==='scan')document.body.dataset.hardwareCode=m.value;original(e)};document.body.dataset.captureReady='yes'", null);
                assertTrue(input.requestFocus());
            });
            awaitJavascript(scenario, "document.body.dataset.captureReady", "yes");
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            InstrumentationRegistry.getInstrumentation().sendStringSync("000123");
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_ENTER);
            awaitJavascript(scenario, "document.body.dataset.hardwareCode", "000123");
            awaitJavascript(scenario, "document.querySelector('#read').textContent", "Barcode read");
            scenario.onActivity(activity -> assertEquals("", findInput(activity.getWindow().getDecorView()).getText().toString()));
        }
    }

    @Test public void trustedVerifierCanAcceptOnlyTheCurrentScan() throws Exception {
        new ReaderConfig("https://verifier.example/reader", List.of("pass.example.member"), "", "")
            .save(InstrumentationRegistry.getInstrumentation().getTargetContext());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView view = findWeb(activity.getWindow().getDecorView());
                view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                        String html = "<div id='connection'>starting</div><div id='read'></div><script>"
                            + "const b=PassBookNative;b.onmessage=e=>{const m=JSON.parse(e.data);"
                            + "if(m.event==='ready')document.querySelector('#connection').textContent='reader connected';"
                            + "if(m.event==='scan'){document.querySelector('#read').textContent=m.value;"
                            + "b.postMessage(JSON.stringify({version:1,op:'result',id:m.id,outcome:'accepted'}));}};"
                            + "b.postMessage(JSON.stringify({version:1,op:'hello'}));</script>";
                        return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                    }
                });
                view.loadUrl("https://verifier.example/reader");
            });
            awaitPage(scenario);
            scenario.onActivity(activity -> activity.barcode("000123"));
            awaitJavascript(scenario, "document.querySelector('#read').textContent", "000123");
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> assertTrue(findText(activity.getWindow().getDecorView(), "Accepted")));
        }
    }

    private static android.widget.EditText findInput(android.view.View view) {
        if (view instanceof android.widget.EditText input) return input;
        if (view instanceof android.view.ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                android.widget.EditText found = findInput(group.getChildAt(i)); if (found != null) return found;
            }
        }
        return null;
    }

    private void awaitPage(ActivityScenario<MainActivity> scenario) throws Exception {
        awaitJavascript(scenario, "document.querySelector('#connection')?.textContent", "reader connected");
    }

    private void awaitJavascript(ActivityScenario<MainActivity> scenario, String expression, String expected) throws Exception {
        long deadline = System.currentTimeMillis() + 15000;
        String lastValue = "";
        while (System.currentTimeMillis() < deadline) {
            CountDownLatch evaluated = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>("");
            scenario.onActivity(activity -> {
                WebView view = findWeb(activity.getWindow().getDecorView());
                view.evaluateJavascript(expression, value -> { result.set(value); evaluated.countDown(); });
            });
            assertTrue(evaluated.await(3, TimeUnit.SECONDS));
            lastValue = result.get();
            if (lastValue.contains(expected)) return;
            Thread.sleep(100);
        }
        AtomicReference<String> nativeText = new AtomicReference<>("");
        scenario.onActivity(activity -> nativeText.set(allText(activity.getWindow().getDecorView())));
        fail("Page never showed " + expected + "; actual=" + lastValue + "; native=" + nativeText.get());
    }

    private static WebView findWeb(android.view.View view) {
        if (view instanceof WebView web) return web;
        if (view instanceof android.view.ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWeb(group.getChildAt(i)); if (found != null) return found;
            }
        }
        return null;
    }
    private static String allText(android.view.View view) {
        String value = view instanceof TextView text ? text.getText().toString() + " | " : "";
        if (view instanceof android.view.ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) value += allText(group.getChildAt(i));
        }
        return value;
    }
    private static boolean findText(android.view.View view, String value) {
        if (view instanceof TextView text && text.getText().toString().equals(value)) return true;
        if (view instanceof android.view.ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) if (findText(group.getChildAt(i), value)) return true;
        }
        return false;
    }
}
