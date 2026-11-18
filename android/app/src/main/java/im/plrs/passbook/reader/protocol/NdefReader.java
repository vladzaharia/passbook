package im.plrs.passbook.reader.protocol;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Reads the first URI or Text record of a Type 2 or Type 4 NDEF tag. Pure: the caller supplies the channel. */
public final class NdefReader {
    public record Ndef(String type, String value) {}
    public record Tag(String uid, boolean uidRandom, String tech, Ndef ndef) {}

    static final int MAX_VALUE_BYTES = 1024;
    private static final int MAX_MESSAGE = 2048;
    private static final byte[] NDEF_AID = {(byte) 0xd2, 0x76, 0, 0, (byte) 0x85, 1, 1};
    private static final String[] URI_PREFIX = {"", "http://www.", "https://www.", "http://", "https://", "tel:",
        "mailto:", "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://", "ftp://",
        "dav://", "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://",
        "btl2cap://", "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:",
        "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"};

    private NdefReader() {}

    /** A phone or DESFire RandomID presents 4 bytes starting 0x08; the server refuses it. */
    public static boolean isRandomUid(byte[] uid) { return uid.length == 4 && uid[0] == 0x08; }

    public static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
        return out.toString();
    }

    /** SELECT answered 6A82 means "not a VAS card": the tag is read as a plain tag instead. */
    public static boolean fallsThroughToTag(String vasCode) { return "UNSUPPORTED_CARD".equals(vasCode); }

    /** Type 4 over IsoDep. Null when the tag has no NDEF application, an empty file or no URI/Text record. */
    public static Ndef readType4(VasReader.Channel channel) throws IOException {
        if (!ok(channel.exchange(select(0x04, NDEF_AID)))) return null;
        if (!ok(channel.exchange(select(0x00, new byte[] {(byte) 0xe1, 0x03})))) return null;
        byte[] cc = data(channel.exchange(new byte[] {0, (byte) 0xb0, 0, 0, 15}));
        if (cc == null || cc.length < 15 || cc[7] != 4 || cc[8] != 6) return null;
        int chunk = ((cc[3] & 255) << 8 | (cc[4] & 255));
        chunk = chunk < 1 || chunk > 255 ? 255 : chunk;
        if (!ok(channel.exchange(select(0x00, new byte[] {cc[9], cc[10]})))) return null;
        byte[] header = data(channel.exchange(new byte[] {0, (byte) 0xb0, 0, 0, 2}));
        if (header == null || header.length != 2) return null;
        int length = (header[0] & 255) << 8 | (header[1] & 255);
        if (length == 0 || length > MAX_MESSAGE) return null;
        ByteArrayOutputStream message = new ByteArrayOutputStream(length);
        while (message.size() < length) {
            int offset = 2 + message.size();
            int want = Math.min(chunk, length - message.size());
            byte[] part = data(channel.exchange(new byte[] {0, (byte) 0xb0, (byte) (offset >> 8), (byte) offset, (byte) want}));
            if (part == null || part.length == 0) return null;
            message.write(part, 0, Math.min(part.length, length - message.size()));
        }
        return parse(message.toByteArray());
    }

    /** Pages 4..255: the READ page byte wraps beyond that. */
    static final int MAX_TYPE2_AREA = 1008;

    /** Type 2 over NfcA: READ (0x30) returns 16 bytes, four pages. */
    public static Ndef readType2(VasReader.Channel channel) throws IOException {
        byte[] cc = page(channel, 3);
        if (cc == null || (cc[0] & 255) != 0xe1) return null;
        int area = Math.min((cc[2] & 255) * 8, MAX_TYPE2_AREA);
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        int at = 0;
        while (true) {
            if (!fill(channel, data, at + 1, area)) return null;
            int tag = data.toByteArray()[at] & 255;
            if (tag == 0xfe) return null;
            if (tag == 0) { at++; continue; }
            if (!fill(channel, data, at + 4, area)) return null;
            byte[] bytes = data.toByteArray();
            int length = bytes[at + 1] & 255;
            int start = at + 2;
            if (length == 0xff) { length = (bytes[at + 2] & 255) << 8 | (bytes[at + 3] & 255); start = at + 4; }
            if (tag != 3) { at = start + length; continue; }
            if (length == 0 || length > MAX_MESSAGE || !fill(channel, data, start + length, area)) return null;
            return parse(Arrays.copyOfRange(data.toByteArray(), start, start + length));
        }
    }

    private static boolean fill(VasReader.Channel channel, ByteArrayOutputStream data, int size, int area) throws IOException {
        if (size > area) return false;
        while (data.size() < size) {
            byte[] block = page(channel, 4 + data.size() / 4);
            if (block == null) return false;
            data.write(block, 0, block.length);
        }
        return true;
    }

    private static byte[] page(VasReader.Channel channel, int page) throws IOException {
        byte[] block = channel.exchange(new byte[] {0x30, (byte) page});
        return block != null && block.length == 16 ? block : null;
    }

    /** First well-known URI ('U') or Text ('T') record; anything else, or a value over 1024 bytes, is no NDEF. */
    static Ndef parse(byte[] message) {
        int at = 0;
        while (at < message.length) {
            int header = message[at++] & 255;
            boolean chunked = (header & 0x20) != 0, shortRecord = (header & 0x10) != 0, hasId = (header & 8) != 0;
            if (at >= message.length) return null;
            int typeLength = message[at++] & 255;
            long payloadLength;
            if (shortRecord) {
                if (at >= message.length) return null;
                payloadLength = message[at++] & 255;
            } else {
                if (at + 4 > message.length) return null;
                payloadLength = (message[at] & 255L) << 24 | (message[at + 1] & 255) << 16 | (message[at + 2] & 255) << 8 | (message[at + 3] & 255);
                at += 4;
            }
            int idLength = 0;
            if (hasId) { if (at >= message.length) return null; idLength = message[at++] & 255; }
            if (payloadLength > MAX_MESSAGE || at + typeLength + idLength + payloadLength > message.length) return null;
            byte[] type = Arrays.copyOfRange(message, at, at + typeLength);
            int payloadAt = at + typeLength + idLength;
            byte[] payload = Arrays.copyOfRange(message, payloadAt, payloadAt + (int) payloadLength);
            at = payloadAt + (int) payloadLength;
            if (chunked) return null;
            if ((header & 7) == 1 && type.length == 1 && payload.length > 0) {
                Ndef record = type[0] == 'U' ? uri(payload) : type[0] == 'T' ? text(payload) : null;
                if (record != null) return record;
            }
            if ((header & 0x40) != 0) return null;
        }
        return null;
    }

    private static Ndef uri(byte[] payload) {
        int code = payload[0] & 255;
        if (code >= URI_PREFIX.length) return null;
        return value("U", URI_PREFIX[code] + new String(payload, 1, payload.length - 1, StandardCharsets.UTF_8));
    }

    private static Ndef text(byte[] payload) {
        int language = payload[0] & 63;
        if (1 + language >= payload.length) return null;
        java.nio.charset.Charset charset = (payload[0] & 0x80) != 0 ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8;
        return value("T", new String(payload, 1 + language, payload.length - 1 - language, charset));
    }

    private static Ndef value(String type, String value) {
        if (value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > MAX_VALUE_BYTES) return null;
        return new Ndef(type, value);
    }

    private static byte[] select(int p1, byte[] data) {
        byte[] command = new byte[5 + data.length + (p1 == 4 ? 1 : 0)];
        command[1] = (byte) 0xa4; command[2] = (byte) p1; command[3] = (byte) (p1 == 4 ? 0 : 0x0c); command[4] = (byte) data.length;
        System.arraycopy(data, 0, command, 5, data.length);
        return command;
    }

    private static boolean ok(byte[] response) {
        return response != null && response.length >= 2 && (response[response.length - 2] & 255) == 0x90 && response[response.length - 1] == 0;
    }

    private static byte[] data(byte[] response) {
        return ok(response) ? Arrays.copyOf(response, response.length - 2) : null;
    }
}
