package im.plrs.passbook.reader.protocol;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Bounded BER-TLV subset used by the VAS APDUs. */
public final class BerTlv {
    public record Item(int tag, byte[] value) {}
    private BerTlv() {}

    public static List<Item> parse(byte[] data) {
        if (data.length > 8192) throw new IllegalArgumentException("Response too large");
        List<Item> result = new ArrayList<>();
        int offset = 0;
        while (offset < data.length) {
            int first = data[offset++] & 255;
            int tag = first;
            if ((first & 31) == 31) {
                int count = 0;
                int next;
                do {
                    if (offset >= data.length || ++count > 2) fail();
                    next = data[offset++] & 255;
                    tag = (tag << 8) | next;
                } while ((next & 128) != 0);
            }
            if (offset >= data.length) fail();
            int length = data[offset++] & 255;
            if ((length & 128) != 0) {
                int count = length & 127;
                if (count == 0 || count > 2 || offset + count > data.length) fail();
                length = 0;
                for (int i = 0; i < count; i++) length = (length << 8) | (data[offset++] & 255);
            }
            if (length > data.length - offset) fail();
            result.add(new Item(tag, Arrays.copyOfRange(data, offset, offset + length)));
            offset += length;
        }
        return result;
    }

    public static byte[] require(byte[] data, int tag) {
        byte[] found = null;
        for (Item item : parse(data)) {
            if (item.tag == tag) {
                if (found != null) throw new IllegalArgumentException("Duplicate TLV");
                found = item.value;
            }
        }
        if (found == null) throw new IllegalArgumentException("Missing TLV");
        return found;
    }

    public static byte[] encode(int tag, byte[] value) {
        if (value.length > 255) throw new IllegalArgumentException("TLV too large");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (tag > 65535) out.write(tag >> 16);
        if (tag > 255) out.write(tag >> 8);
        out.write(tag);
        if (value.length >= 128) out.write(0x81);
        out.write(value.length);
        out.write(value, 0, value.length);
        return out.toByteArray();
    }

    public static byte[] concat(byte[]... arrays) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] array : arrays) out.write(array, 0, array.length);
        return out.toByteArray();
    }

    private static void fail() { throw new IllegalArgumentException("Malformed TLV"); }
}
