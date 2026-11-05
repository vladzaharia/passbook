package im.plrs.passbook.reader.protocol;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.List;

/** VAS-only exchange adapted from kormax/android-universal-reader (Apache-2.0). */
public final class VasReader {
    public interface Channel { byte[] exchange(byte[] command) throws IOException; }
    public record Read(String passTypeIdentifier, byte[] cryptogram) {}
    public static final class ReadException extends IOException {
        public final String code;
        public ReadException(String code) { super(code); this.code = code; }
    }
    private final SecureRandom random = new SecureRandom();

    public Read read(Channel channel, List<String> identifiers) throws IOException {
        if (identifiers.isEmpty() || identifiers.size() > 8) throw new ReadException("NO_PROFILES");
        byte[] select = apdu(0, 0xa4, 4, 0, "OSE.VAS.01".getBytes(StandardCharsets.US_ASCII));
        byte[] directory = payload(channel.exchange(select));
        byte[] fci = BerTlv.require(directory, 0x6f);
        String provider = new String(BerTlv.require(fci, 0x50), StandardCharsets.US_ASCII);
        if (!provider.equals("ApplePay")) throw new ReadException("UNSUPPORTED_WALLET");
        byte[] version = BerTlv.require(fci, 0x9f21);
        if (!Arrays.equals(version, new byte[] {1, 0})) throw new ReadException("UNSUPPORTED_VERSION");
        for (int index = 0; index < identifiers.size(); index++) {
            String identifier = identifiers.get(index);
            byte[] nonce = new byte[4];
            random.nextBytes(nonce);
            // VAS only, NFC terminal, no payment APDUs. Continuation only before the last profile.
            byte[] capabilities = {0, (byte) 0x80, 0, (byte) (index < identifiers.size() - 1 ? 0x82 : 2)};
            byte[] request = BerTlv.concat(
                BerTlv.encode(0x9f22, new byte[] {1, 0}),
                BerTlv.encode(0x9f25, sha256(identifier.getBytes(StandardCharsets.UTF_8))),
                BerTlv.encode(0x9f26, capabilities), BerTlv.encode(0x9f28, nonce));
            byte[] response = channel.exchange(apdu(0x80, 0xca, 1, 1, request));
            int status = status(response);
            if (status == 0x6a83) continue;
            byte[] body = payload(response);
            byte[] cryptogram = BerTlv.require(BerTlv.require(body, 0x70), 0x9f27);
            // Key id (4), ephemeral public x (32), timestamp (4), GCM tag (16), payload (1..64).
            if (cryptogram.length < 57 || cryptogram.length > 120) throw new ReadException("INVALID_CRYPTOGRAM");
            return new Read(identifier, cryptogram);
        }
        throw new ReadException("PASS_NOT_FOUND");
    }

    public static int status(byte[] response) throws ReadException {
        if (response == null || response.length < 2 || response.length > 8192) {
            throw new ReadException("INVALID_RESPONSE");
        }
        return ((response[response.length - 2] & 255) << 8) | (response[response.length - 1] & 255);
    }

    private static byte[] payload(byte[] response) throws ReadException {
        int status = status(response);
        switch (status) {
            case 0x9000: return Arrays.copyOf(response, response.length - 2);
            case 0x6287: case 0x6984: throw new ReadException("AUTHENTICATION_REQUIRED");
            case 0x6a83: throw new ReadException("PASS_NOT_FOUND");
            case 0x6a82: throw new ReadException("UNSUPPORTED_CARD");
            default: throw new ReadException("VAS_STATUS_" + Integer.toHexString(status));
        }
    }

    static byte[] apdu(int cla, int instruction, int p1, int p2, byte[] data) {
        if (data.length > 255) throw new IllegalArgumentException("APDU too large");
        return BerTlv.concat(new byte[] {(byte) cla, (byte) instruction, (byte) p1, (byte) p2,
            (byte) data.length}, data, new byte[] {0});
    }

    private static byte[] sha256(byte[] bytes) {
        try { return MessageDigest.getInstance("SHA-256").digest(bytes); }
        catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
