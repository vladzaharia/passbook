package im.plrs.passbook.reader;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URI;
import java.util.Arrays;
import java.util.List;

public record ReaderConfig(String verifierUrl, List<String> passTypeIds, String barcodeAction,
                           String barcodeExtra) {
    public static final String LOCAL_ORIGIN = "https://appassets.androidplatform.net";
    public static final String HOME = LOCAL_ORIGIN + "/assets/index.html";
    public static final String DEFAULT_VERIFIER = "https://passbook.mobile/scan";
    public static final String DEFAULT_ID = "pass.im.plrs.wallet";

    public ReaderConfig {
        verifierUrl = verifierUrl.trim();
        if (!verifierUrl.isEmpty()) validateUrl(verifierUrl);
        passTypeIds = List.copyOf(passTypeIds);
        if (passTypeIds.isEmpty() || passTypeIds.size() > 8) invalid("Enter one to eight Pass Type IDs.");
        for (String id : passTypeIds) {
            if (!id.matches("pass\\.[A-Za-z0-9.-]{1,240}")) invalid("Enter a valid Pass Type ID.");
        }
        if (passTypeIds.stream().distinct().count() != passTypeIds.size()) invalid("Remove duplicate Pass Type IDs.");
        if (barcodeAction.length() > 200 || barcodeExtra.length() > 100) invalid("Scanner settings are too long.");
        if (!barcodeAction.isEmpty() && (!barcodeAction.matches("[A-Za-z][A-Za-z0-9_.]+")
            || barcodeAction.startsWith("android.") || barcodeExtra.isBlank())) {
            invalid("Enter the scanner broadcast action and text extra.");
        }
    }

    public String url() { return verifierUrl.isEmpty() ? HOME : verifierUrl; }
    public String origin() { return originOf(url()); }
    public boolean isLocal() { return verifierUrl.isEmpty(); }

    public static String originOf(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getPort() < -1) return "";
            int port = uri.getPort();
            return "https://" + uri.getHost().toLowerCase(java.util.Locale.ROOT)
                + (port == -1 || port == 443 ? "" : ":" + port);
        } catch (java.net.URISyntaxException exception) { return ""; }
    }

    private static void validateUrl(String value) {
        if (value.length() > 2048 || originOf(value).isEmpty() || value.contains("#")) {
            invalid("Enter an HTTPS verifier URL without a fragment or credentials.");
        }
        if (originOf(value).equals(LOCAL_ORIGIN)) invalid("Use an external verifier URL or leave it empty.");
    }

    public static ReaderConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("reader", Context.MODE_PRIVATE);
        return new ReaderConfig(prefs.getString("url", DEFAULT_VERIFIER), parseIds(prefs.getString("ids", DEFAULT_ID)),
            prefs.getString("action", ""), prefs.getString("extra", ""));
    }

    public void save(Context context) {
        context.getSharedPreferences("reader", Context.MODE_PRIVATE).edit()
            .putString("url", verifierUrl).putString("ids", String.join("\n", passTypeIds))
            .putString("action", barcodeAction).putString("extra", barcodeExtra).apply();
    }

    public static List<String> parseIds(String text) {
        return Arrays.stream(text.split("[\\s,]+", -1)).filter(id -> !id.isBlank()).toList();
    }

    private static void invalid(String message) { throw new IllegalArgumentException(message); }
}
