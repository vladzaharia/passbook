package im.plrs.passbook.reader;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public class HardwareTest {
    private static Hardware.Snapshot snap(List<Hardware.Input> inputs, Set<String> packages) {
        return new Hardware.Snapshot(List.of("back", "front"), "granted", true, true, false, inputs, packages,
            List.of("USB Scanner"), List.of(), true, true);
    }
    private static Hardware.Entry first(List<Hardware.Entry> entries, String kind) {
        return entries.stream().filter(e -> e.kind().equals(kind)).findFirst().orElse(null);
    }

    @Test public void builtInScannerInputBecomesBarcode() {
        List<Hardware.Entry> out = Hardware.build(snap(List.of(
            new Hardware.Input(4, "Honeywell Scanner Keypad", "", true, false, false),
            new Hardware.Input(5, "gpio-keys", "", true, false, false)), Set.of()));
        Hardware.Entry barcode = first(out, "barcode");
        assertTrue(barcode.builtIn()); assertEquals("input-4", barcode.id()); assertEquals("ready", barcode.state());
        assertEquals(1, out.stream().filter(e -> e.kind().equals("barcode")).count());
        assertNull(first(out, "keyboard"));
    }

    @Test public void descriptorMarksScannerButIsNeverReported() {
        List<Hardware.Entry> out = Hardware.build(snap(List.of(
            new Hardware.Input(7, "Keypad", "sec-barcode-ABC123", true, false, false)), Set.of()));
        assertEquals("Keypad", first(out, "barcode").name());
        assertFalse(out.toString().contains("ABC123"));
    }

    @Test public void externalKeyboardClassIsAKeyboardNotABuiltInReader() {
        List<Hardware.Entry> out = Hardware.build(snap(List.of(
            new Hardware.Input(9, "Datalogic Gryphon", "", true, true, false),
            new Hardware.Input(10, "Virtual", "", true, false, true)), Set.of()));
        assertNull(first(out, "barcode"));
        Hardware.Entry keyboard = first(out, "keyboard");
        assertFalse(keyboard.builtIn()); assertEquals(Boolean.TRUE, keyboard.connected());
        assertEquals(1, out.stream().filter(e -> e.kind().equals("keyboard")).count());
    }

    @Test public void vendorPackageMarksBuiltInReaderReady() {
        List<Hardware.Entry> out = Hardware.build(snap(List.of(), Set.of("com.symbol.datawedge")));
        Hardware.Entry barcode = first(out, "barcode");
        assertEquals("vendor-zebra", barcode.id()); assertTrue(barcode.builtIn()); assertEquals("ready", barcode.state());
    }

    @Test public void inputDeviceAndVendorServiceListOneReader() {
        List<Hardware.Entry> out = Hardware.build(snap(List.of(
            new Hardware.Input(4, "sunmi scanner", "", true, false, false)), Set.of("com.sunmi.scanner")));
        assertEquals(1, out.stream().filter(e -> e.kind().equals("barcode")).count());
    }

    @Test public void presentVendorsDriveBroadcastRegistration() {
        assertTrue(Hardware.present(Set.of("com.example")).isEmpty());
        List<Hardware.Vendor> found = Hardware.present(Set.of("com.nlscan.android.scan", "com.sunmi.scanner"));
        assertEquals(2, found.size());
        assertTrue(found.stream().anyMatch(v -> v.action().equals("nlscan.action.SCANNER_RESULT")));
    }

    @Test public void nfcStates() {
        Hardware.Snapshot base = snap(List.of(), Set.of());
        assertEquals("ready", first(Hardware.build(base), "nfc").state());
        Hardware.Entry off = first(Hardware.build(new Hardware.Snapshot(base.cameraFacings(), "granted", true, false,
            false, List.of(), Set.of(), List.of(), List.of(), false, false)), "nfc");
        assertEquals("off", off.state()); assertEquals("NFC is off in Settings", off.reason());
        Hardware.Entry active = first(Hardware.build(new Hardware.Snapshot(base.cameraFacings(), "granted", true, true,
            true, List.of(), Set.of(), List.of(), List.of(), false, false)), "nfc");
        assertEquals("active", active.state());
        assertNull(first(Hardware.build(new Hardware.Snapshot(List.of(), "granted", false, false, false, List.of(),
            Set.of(), List.of(), List.of(), false, false)), "nfc"));
    }

    @Test public void camerasCarryFacingAndPermission() {
        List<Hardware.Entry> out = Hardware.build(new Hardware.Snapshot(List.of("back", "external"), "unknown", false,
            false, false, List.of(), Set.of(), List.of(), List.of(), false, false));
        assertEquals(2, out.size());
        assertEquals("back", out.get(0).facing()); assertTrue(out.get(0).builtIn());
        assertEquals("needs-permission", out.get(0).state());
        assertFalse(out.get(1).builtIn());
        assertEquals("unavailable", Hardware.build(new Hardware.Snapshot(List.of("back"), "restricted", false, false,
            false, List.of(), Set.of(), List.of(), List.of(), false, false)).get(0).state());
    }

    @Test public void usbBluetoothHapticsAndSpeaker() {
        Hardware.Snapshot s = new Hardware.Snapshot(List.of(), "granted", false, false, false, List.of(), Set.of(),
            List.of("Barcode Reader"), List.of("Wedge"), true, true);
        List<Hardware.Entry> out = Hardware.build(s);
        assertEquals("usb-0", first(out, "usb").id()); assertEquals(Boolean.TRUE, first(out, "usb").connected());
        assertNull(first(out, "bluetooth").connected());
        assertTrue(first(out, "haptics").builtIn()); assertNotNull(first(out, "speaker"));
    }

    @Test public void boundsApply() {
        String longName = "x".repeat(200);
        List<Hardware.Entry> out = Hardware.build(new Hardware.Snapshot(List.of(), "granted", false, false, false,
            List.of(), Set.of(), List.of(longName), List.of(), false, false));
        assertEquals(80, out.get(0).name().length());
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 40; i++) many.add("u" + i);
        List<Hardware.Entry> capped = Hardware.build(new Hardware.Snapshot(List.of(), "granted", false, false, false,
            List.of(), Set.of(), many, List.of(), false, false));
        assertEquals(16, capped.size());
        for (Hardware.Entry e : capped) assertTrue(e.id().length() <= 64);
    }

    @Test public void intentValuesAreBoundedLikeTypedInput() {
        assertTrue(Hardware.validBarcode("ABC-123"));
        assertTrue(Hardware.validBarcode("x".repeat(2048)));
        assertFalse(Hardware.validBarcode("x".repeat(2049)));
        assertFalse(Hardware.validBarcode(null));
        assertFalse(Hardware.validBarcode(""));
        assertFalse(Hardware.validBarcode("a\nb"));
        assertFalse(Hardware.validBarcode("a\u0000b"));
        assertFalse(Hardware.validBarcode("a\u001bb"));
    }

    @Test public void unverifiedVendorsAreFlaggedAndOnlyZebraAndSunmiAreVerified() {
        for (Hardware.Vendor v : Hardware.VENDORS) {
            assertEquals(v.name(), v.name().equals("zebra") || v.name().equals("sunmi"), v.verified());
        }
    }

    @Test public void receiverFilterAcceptsTheDefaultCategoryDataWedgeMayAdd() {
        Hardware.Registration reg = Hardware.registration("", Hardware.present(Set.of("com.symbol.datawedge")));
        assertEquals(List.of("im.plrs.passbook.reader.action.SCAN"), reg.actions());
        assertTrue(reg.categories().contains("android.intent.category.DEFAULT"));
        Hardware.Registration both = Hardware.registration("custom.SCAN", Hardware.present(Set.of("com.sunmi.scanner")));
        assertEquals(List.of("custom.SCAN", "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED"), both.actions());
    }

    @Test public void beforeApi34OnlyAFullKeyboardWithAVendorIdCountsAsAttached() {
        assertTrue(Hardware.externalBeforeApi34("Logitech USB Keyboard", 0x046d, true, false));
        assertFalse(Hardware.externalBeforeApi34("gpio-keys", 1, true, false));
        assertFalse(Hardware.externalBeforeApi34("Headset Jack", 1, true, false));
        assertFalse(Hardware.externalBeforeApi34("Volume keys", 0x0001, false, false));
        assertFalse(Hardware.externalBeforeApi34("Some Keyboard", 0, true, false));
        // A USB-attached internal scan engine with its vendor service installed is the built-in reader.
        assertFalse(Hardware.externalBeforeApi34("Newland Scanner", 0x1eab, true, true));
        assertTrue(Hardware.externalBeforeApi34("Newland Scanner", 0x1eab, true, false));
    }

    @Test public void inputIdsAreStablePerDeviceAndSalt() {
        assertEquals(Hardware.stableId("sec-1", "salt"), Hardware.stableId("sec-1", "salt"));
        assertNotEquals(Hardware.stableId("sec-1", "salt"), Hardware.stableId("sec-2", "salt"));
        assertNotEquals(Hardware.stableId("sec-1", "salt"), Hardware.stableId("sec-1", "other"));
        assertTrue(Hardware.stableId("sec-1", "salt") >= 0);
    }

    @Test public void aNonAlphabeticNodeIsNeverListedAsAKeyboardButStillCountsAsABuiltInReader() {
        List<Hardware.Entry> entries = Hardware.build(new Hardware.Snapshot(List.of(), "granted", false, false, false,
            List.of(new Hardware.Input(1, "Volume keys", "", true, true, false, false),
                new Hardware.Input(2, "Sunmi Scanner", "", true, false, false, false)), Set.of(), List.of(), List.of(), false, false));
        assertTrue(entries.stream().noneMatch(entry -> entry.kind().equals("keyboard")));
        assertTrue(entries.stream().anyMatch(entry -> entry.kind().equals("barcode") && entry.builtIn()));
    }

    @Test public void namesAreNotCutThroughASurrogatePair() {
        String name = "x".repeat(Hardware.MAX_NAME - 1) + "\uD83D\uDE00";
        List<Hardware.Entry> entries = Hardware.build(new Hardware.Snapshot(List.of(), "granted", false, false, false,
            List.of(new Hardware.Input(1, name, "", true, true, false)), Set.of(), List.of(), List.of(), false, false));
        String cut = entries.get(0).name();
        assertFalse(Character.isHighSurrogate(cut.charAt(cut.length() - 1)));
    }
}
