package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
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
            .getSharedPreferences("reader", 0).edit().clear().commit();
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
                input.requestFocus(); input.setText("000123");
                input.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER));
                input.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_ENTER));
            });
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
        while (System.currentTimeMillis() < deadline) {
            CountDownLatch evaluated = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>("");
            scenario.onActivity(activity -> {
                WebView view = findWeb(activity.getWindow().getDecorView());
                view.evaluateJavascript(expression, value -> { result.set(value); evaluated.countDown(); });
            });
            assertTrue(evaluated.await(3, TimeUnit.SECONDS));
            if (result.get().contains(expected)) return;
            Thread.sleep(100);
        }
        fail("Page never showed " + expected);
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
    private static boolean findText(android.view.View view, String value) {
        if (view instanceof TextView text && text.getText().toString().equals(value)) return true;
        if (view instanceof android.view.ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) if (findText(group.getChildAt(i), value)) return true;
        }
        return false;
    }
}
