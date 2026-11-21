package im.plrs.passbook.reader;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pure mapping from what the OS reported to the bridge's `hardware` array. No Android types, so it
 * is unit-testable. Ids are positional or OS-assigned small numbers, never serials or MACs.
 */
final class Hardware {
    static final int MAX_ENTRIES = 16;
    static final int MAX_ID = 64;
    static final int MAX_NAME = 80;
    static final int MAX_REASON = 120;
    private static final String[] SCANNER_WORDS = {"scanner", "barcode", "scan", "honeywell", "zebra",
        "symbol", "datalogic", "urovo", "newland", "sunmi", "chainway"};

    /**
     * A vendor scanner service with a broadcast-intent output. {@code verified} means the action, extra and
     * package name are all confirmed in the vendor's published documentation; others stay off unless
     * {@link ReaderConfig#unverifiedScanners()} is set.
     */
    record Vendor(String name, List<String> packages, String action, String extra, boolean verified) {}

    static final List<Vendor> VENDORS = List.of(
        // Zebra: the action is chosen in the DataWedge profile; the app creates one that uses this action.
        new Vendor("zebra", List.of("com.symbol.datawedge"), "im.plrs.passbook.reader.action.SCAN",
            "com.symbol.datawedge.data_string", true),
        new Vendor("sunmi", List.of("com.sunmi.scanner"), "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED", "data", true),
        // Honeywell: the action is chosen by the app that claims the scanner (needs the DECODE permission);
        // there is no fixed default, so this one cannot work without a claim.
        new Vendor("honeywell", List.of("com.intermec.datacollectionservice", "com.honeywell.decode.service"),
            "com.honeywell.sample.action.BARCODE_DATA", "data", false),
        // Urovo and Newland: action and extra are documented; the service package names are not confirmed.
        new Vendor("urovo", List.of("com.ubx.scanner", "com.ubx.datawedge"), "android.intent.ACTION_DECODE_DATA",
            "barcode_string", false),
        new Vendor("newland", List.of("com.nlscan.android.scan", "com.nlscan.scanservice"),
            "nlscan.action.SCANNER_RESULT", "SCAN_BARCODE1", false));

    record Entry(String kind, String id, String name, boolean builtIn, Boolean connected, String state,
                 String facing, String trigger, String reason) {}

    /** An input device as the OS describes it. {@code descriptor} is only matched, never reported. */
    record Input(int id, String name, String descriptor, boolean keyboard, boolean external, boolean virtual) {}

    record Snapshot(List<String> cameraFacings, String cameraPermission, boolean nfcSupported, boolean nfcEnabled,
                    boolean nfcReading, List<Input> inputs, Set<String> installedPackages, List<String> usbNames,
                    List<String> bluetoothNames, boolean vibrator, boolean speaker) {}

    private Hardware() {}

    /** Actions and categories one receiver registers. DataWedge-style senders may add the DEFAULT category. */
    record Registration(List<String> actions, List<String> categories) {}

    static Registration registration(String configuredAction, List<Vendor> vendors) {
        List<String> actions = new ArrayList<>();
        if (configuredAction != null && !configuredAction.isEmpty()) actions.add(configuredAction);
        for (Vendor vendor : vendors) if (!actions.contains(vendor.action())) actions.add(vendor.action());
        return new Registration(actions, List.of("android.intent.category.DEFAULT"));
    }

    /** Same bounds as keyboard input: 1 to 2048 characters, no control characters. */
    static boolean validBarcode(String value) {
        return value != null && !value.isEmpty() && value.length() <= 2048 && value.chars().noneMatch(Character::isISOControl);
    }

    /** Vendors whose scanner service is installed. */
    static List<Vendor> present(Set<String> installed) {
        List<Vendor> out = new ArrayList<>();
        for (Vendor vendor : VENDORS) {
            for (String pkg : vendor.packages()) {
                if (installed.contains(pkg)) { out.add(vendor); break; }
            }
        }
        return out;
    }

    static boolean scannerLike(String name, String descriptor) {
        String text = ((name == null ? "" : name) + " " + (descriptor == null ? "" : descriptor)).toLowerCase(Locale.ROOT);
        for (String word : SCANNER_WORDS) if (text.contains(word)) return true;
        return false;
    }

    static List<Entry> build(Snapshot s) {
        List<Entry> out = new ArrayList<>();
        boolean builtInReader = false;
        for (Input input : s.inputs()) {
            if (input.keyboard() && !input.external() && !input.virtual() && scannerLike(input.name(), input.descriptor())) {
                out.add(entry("barcode", "input-" + input.id(), input.name(), true, true, "ready", null, "unknown", null));
                builtInReader = true;
            }
        }
        List<Vendor> vendors = present(s.installedPackages());
        // An input device and the vendor service are usually the same reader; list it once.
        if (!builtInReader && !vendors.isEmpty()) {
            out.add(entry("barcode", "vendor-" + vendors.get(0).name(), null, true, true, "ready", null, "unknown", null));
        }
        if (s.nfcSupported()) {
            out.add(!s.nfcEnabled()
                ? entry("nfc", "nfc", null, true, true, "off", null, null, "NFC is off in Settings")
                : entry("nfc", "nfc", null, true, true, s.nfcReading() ? "active" : "ready", null, null, null));
        }
        for (int i = 0; i < s.cameraFacings().size(); i++) {
            out.add(camera(i, s.cameraFacings().get(i), s.cameraPermission()));
        }
        for (Input input : s.inputs()) {
            if (input.keyboard() && input.external() && !input.virtual()) {
                out.add(entry("keyboard", "input-" + input.id(), input.name(), false, true, "ready", null, null, null));
            }
        }
        for (int i = 0; i < s.usbNames().size(); i++) {
            out.add(entry("usb", "usb-" + i, s.usbNames().get(i), false, true, "ready", null, null, null));
        }
        for (int i = 0; i < s.bluetoothNames().size(); i++) {
            out.add(entry("bluetooth", "bt-" + i, s.bluetoothNames().get(i), false, null, "ready", null, null, null));
        }
        if (s.vibrator()) out.add(entry("haptics", "haptics", null, true, true, "ready", null, null, null));
        if (s.speaker()) out.add(entry("speaker", "speaker", null, true, true, "ready", null, null, null));
        return out.size() > MAX_ENTRIES ? new ArrayList<>(out.subList(0, MAX_ENTRIES)) : out;
    }

    private static Entry camera(int index, String facing, String permission) {
        String state = switch (permission) {
            case "granted" -> "ready";
            case "restricted", "unavailable" -> "unavailable";
            default -> "needs-permission";
        };
        String reason = state.equals("unavailable") ? "Camera is blocked or unavailable" : null;
        return entry("camera", "camera-" + index, null, !facing.equals("external"), true, state, facing, null, reason);
    }

    private static Entry entry(String kind, String id, String name, boolean builtIn, Boolean connected,
                               String state, String facing, String trigger, String reason) {
        return new Entry(kind, cut(id, MAX_ID), name == null || name.isBlank() ? null : cut(name.trim(), MAX_NAME),
            builtIn, connected, state, facing, trigger, reason == null ? null : cut(reason, MAX_REASON));
    }

    private static String cut(String value, int max) { return value.length() <= max ? value : value.substring(0, max); }
}
