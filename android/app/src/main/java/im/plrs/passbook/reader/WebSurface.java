package im.plrs.passbook.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebMessageCompat;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

public final class WebSurface {
    public interface Listener {
        void reset();
        void command(JSONObject message);
        void notice(String message);
        void camera(PermissionRequest request);
        default void cameraCancelled(PermissionRequest request) {}
    }
    public final WebView view;
    private final Listener listener;
    private final WebViewAssetLoader assets;
    private ReaderConfig config;
    private JavaScriptReplyProxy reply;
    private boolean ready;

    @SuppressLint("SetJavaScriptEnabled")
    public WebSurface(Activity activity, Listener listener) {
        this.listener = listener;
        view = new WebView(activity);
        view.setContentDescription("PassBook verifier");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(activity)).build();
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public void onPageStarted(WebView web, String url, android.graphics.Bitmap icon) {
                invalidate();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                // HTTPS identity-provider redirects may complete in the same cookie jar; only
                // the configured verifier origin gets a native bridge or camera access.
                boolean allowed = !ReaderConfig.originOf(request.getUrl().toString()).isEmpty();
                if (!allowed && request.isForMainFrame()) listener.notice("Only HTTPS navigation is supported.");
                return !allowed;
            }
            @Override public void onReceivedError(WebView web, WebResourceRequest request,
                                                   android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    invalidate();
                    listener.notice("Verifier unavailable. Check the connection and reload.");
                }
            }
            @Override public void onReceivedHttpError(WebView web, WebResourceRequest request,
                                                      WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                    invalidate();
                    listener.notice("Verifier unavailable. Check the URL and reload.");
                }
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (!trusted(request.getOrigin().toString())) { request.deny(); return; }
                listener.camera(request);
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { listener.cameraCancelled(request); }
        });
    }

    public void load(ReaderConfig next) {
        invalidate();
        config = next;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.removeWebMessageListener(view, "PassBookNative");
        WebViewCompat.addWebMessageListener(view, "PassBookNative", Set.of(next.origin()),
            (web, message, origin, mainFrame, proxy) -> {
                if (!mainFrame || !trusted(origin.toString()) || !trusted(view.getUrl())) return;
                if (message.getType() != WebMessageCompat.TYPE_STRING) return;
                String data = message.getData();
                if (data == null || data.length() > 8192) return;
                try {
                    JSONObject json = new JSONObject(data);
                    if (json.optInt("version") != 1) return;
                    if (json.optString("op").equals("hello")) {
                        reply = proxy;
                        ready = true;
                    }
                    if (ready) listener.command(json);
                } catch (JSONException exception) {
                    listener.notice("Verifier sent an invalid reader message.");
                }
            });
            view.loadUrl(next.url());
        } else listener.notice("Update Android System WebView to connect the reader.");
    }

    public boolean send(JSONObject message) {
        if (!ready || reply == null || !trusted(view.getUrl())) return false;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            reply.postMessage(message.toString());
            return true;
        }
        return false;
    }

    public void invalidate() {
        ready = false;
        reply = null;
        listener.reset();
    }

    public boolean isReady() { return ready && trusted(view.getUrl()); }
    public boolean trusted(String url) {
        return config != null && url != null && ReaderConfig.originOf(url).equals(config.origin());
    }
    public void destroy() { invalidate(); view.destroy(); }
}
