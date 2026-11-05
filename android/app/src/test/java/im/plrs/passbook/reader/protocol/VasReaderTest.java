package im.plrs.passbook.reader.protocol;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class VasReaderTest {
    private static byte[] response(byte[] data) { return BerTlv.concat(data, new byte[] {(byte) 0x90, 0}); }
    private static byte[] directory(String name) {
        return response(BerTlv.encode(0x6f, BerTlv.concat(
            BerTlv.encode(0x50, name.getBytes(StandardCharsets.US_ASCII)),
            BerTlv.encode(0x9f21, new byte[] {1, 0}))));
    }
    private static byte[] pass() { return response(BerTlv.encode(0x70, BerTlv.encode(0x9f27, new byte[57]))); }
    private static byte[] body(byte[] command) { return Arrays.copyOfRange(command, 5, command.length - 1); }

    @Test public void selectsVasAndReadsEncryptedPayloadWithoutLocalKeys() throws Exception {
        List<byte[]> commands = new ArrayList<>();
        VasReader.Read read = new VasReader().read(command -> {
            commands.add(command);
            return commands.size() == 1 ? directory("ApplePay") : pass();
        }, List.of("pass.example.member"));
        assertEquals("pass.example.member", read.passTypeIdentifier());
        assertEquals(57, read.cryptogram().length);
        assertArrayEquals("OSE.VAS.01".getBytes(StandardCharsets.US_ASCII), body(commands.get(0)));
        assertEquals(0xca, commands.get(1)[1] & 255);
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest("pass.example.member".getBytes(StandardCharsets.UTF_8)),
            BerTlv.require(body(commands.get(1)), 0x9f25));
        assertArrayEquals(new byte[] {0, (byte) 0x80, 0, 2}, BerTlv.require(body(commands.get(1)), 0x9f26));
    }

    @Test public void skipsMissingProfilesAndClearsContinuationOnLastProfile() throws Exception {
        List<byte[]> commands = new ArrayList<>();
        new VasReader().read(command -> {
            commands.add(command);
            return commands.size() == 1 ? directory("ApplePay") : commands.size() == 2
                ? new byte[] {0x6a, (byte) 0x83} : pass();
        }, List.of("pass.example.one", "pass.example.two"));
        assertEquals(0x82, BerTlv.require(body(commands.get(1)), 0x9f26)[3] & 255);
        assertEquals(2, BerTlv.require(body(commands.get(2)), 0x9f26)[3]);
        assertFalse(Arrays.equals(BerTlv.require(body(commands.get(1)), 0x9f28), BerTlv.require(body(commands.get(2)), 0x9f28)));
    }

    @Test public void preservesAuthenticationAndCardErrors() throws Exception {
        for (byte[] sw : new byte[][] {{0x62, (byte) 0x87}, {0x69, (byte) 0x84}}) {
            final int[] count = {0};
            VasReader.ReadException error = assertThrows(VasReader.ReadException.class,
                () -> new VasReader().read(command -> ++count[0] == 1 ? directory("ApplePay") : sw, List.of("pass.example.one")));
            assertEquals("AUTHENTICATION_REQUIRED", error.code);
        }
        assertEquals("UNSUPPORTED_WALLET", assertThrows(VasReader.ReadException.class,
            () -> new VasReader().read(command -> directory("AndroidPay"), List.of("pass.example.one"))).code);
        assertThrows(VasReader.ReadException.class, () -> VasReader.status(new byte[] {0}));
    }

    @Test public void rejectsOversizedAndTruncatedCryptograms() {
        for (int length : new int[] {0, 36, 56, 121, 250}) {
            final int[] count = {0};
            assertThrows(VasReader.ReadException.class, () -> new VasReader().read(command ->
                ++count[0] == 1 ? directory("ApplePay") : response(BerTlv.encode(0x70,
                    BerTlv.encode(0x9f27, new byte[length]))), List.of("pass.example.one")));
        }
    }
}
