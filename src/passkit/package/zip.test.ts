import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32 } from './crc32.ts';
import {
  PackageLimitError,
  PKPASS_CONTENT_TYPE,
  PKPASSES_CONTENT_TYPE,
  PKPASSES_MAX_BYTES,
  PKPASSES_MAX_PASSES,
  packagePass,
  packagePassBytes,
  packagePasses,
  zipBytes,
  zipStream,
} from './zip.ts';

const dir = mkdtempSync(join(tmpdir(), 'wallet-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
};
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
};
const bytesOf = (text: string) => new TextEncoder().encode(text);
const randomBytes = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 3)) & 255;
  return out;
};
const unzipTest = (data: Uint8Array): string | undefined => {
  const file = join(dir, 'x.zip');
  writeFileSync(file, data);
  try {
    return execFileSync('unzip', ['-tq', file], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it('matches node:zlib for every length around the 8-byte stride and for chunked input', () => {
    for (let n = 0; n < 70; n++) {
      const data = randomBytes(n);
      expect(crc32(data), `length ${n}`).toBe(nodeCrc32(data));
    }
    const big = randomBytes(100_003);
    expect(crc32(big)).toBe(nodeCrc32(big));
    expect(crc32(big.subarray(50_000), crc32(big.subarray(0, 50_000)))).toBe(nodeCrc32(big));
  });
});

describe('zipBytes', () => {
  const entries = [
    { name: 'a.txt', bytes: bytesOf('hello') },
    { name: 'dir/b.bin', bytes: randomBytes(1000) },
    { name: 'empty.txt', bytes: new Uint8Array() },
    { name: 'café.txt', bytes: bytesOf('x') },
  ];

  it('is read back by fflate and checked by unzip', () => {
    const zip = zipBytes(entries);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(files[e.name]).toEqual(e.bytes);
    const out = unzipTest(zip);
    if (out !== undefined) expect(out).toMatch(/No errors/);
  });

  it('is deterministic and uses STORE', () => {
    const a = zipBytes(entries);
    expect(zipBytes(entries)).toEqual(a);
    expect(a.length).toBeLessThan(
      entries.reduce((n, e) => n + e.bytes.length, 0) + 4 * (30 + 46 + 12) + 22 + 200,
    );
  });

  it('rejects unsafe and duplicate names', () => {
    for (const name of ['', '/abs', '../x', 'a/../b', 'a\\b', 'a//b', 'nul\0']) {
      expect(() => zipBytes([{ name, bytes: new Uint8Array() }]), name).toThrow(PackageLimitError);
    }
    expect(() =>
      zipBytes([
        { name: 'a', bytes: new Uint8Array() },
        { name: 'a', bytes: new Uint8Array() },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe('zipStream', () => {
  it('produces the same archive as zipBytes', async () => {
    const entries = [
      { name: 'a.txt', bytes: bytesOf('hello') },
      { name: 'b.bin', bytes: randomBytes(70_000) },
    ];
    const streamed = concat(await collect(zipStream(entries)));
    expect(streamed).toEqual(zipBytes(entries));
    const out = unzipTest(streamed);
    if (out !== undefined) expect(out).toMatch(/No errors/);
  });

  it('enqueues entry bytes without copying them', async () => {
    const payload = randomBytes(5000);
    const chunks = await collect(zipStream([{ name: 'p.bin', bytes: payload }]));
    expect(chunks.some((c) => c === payload)).toBe(true);
  });

  it('uses a supplied CRC instead of computing one', async () => {
    const payload = bytesOf('abc');
    const zip = concat(
      await collect(zipStream([{ name: 'p', bytes: payload, crc32: 0x11223344 }])),
    );
    expect(new DataView(zip.buffer).getUint32(14, true)).toBe(0x11223344);
    const own = concat(await collect(zipStream([{ name: 'p', bytes: payload }])));
    expect(new DataView(own.buffer).getUint32(14, true)).toBe(crc32(payload));
  });

  it('streams a body with known size and CRC without buffering it', async () => {
    const payload = randomBytes(300_000);
    const body = () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < payload.length; i += 65_536)
              controller.enqueue(payload.subarray(i, i + 65_536));
            controller.close();
          },
        }),
      );
    const zip = concat(
      await collect(
        zipStream([{ name: 'big.bin', body, size: payload.length, crc32: crc32(payload) }]),
      ),
    );
    expect(unzipSync(zip)['big.bin']).toEqual(payload);
  });

  it('errors when a body does not match its declared size or CRC', async () => {
    const body = () =>
      Promise.resolve(new Response(bytesOf('abc')).body as ReadableStream<Uint8Array>);
    await expect(collect(zipStream([{ name: 'x', body, size: 3, crc32: 1 }]))).rejects.toThrow(
      /CRC/,
    );
    await expect(
      collect(zipStream([{ name: 'x', body, size: 2, crc32: crc32(bytesOf('abc')) }])),
    ).rejects.toThrow();
    await expect(
      collect(zipStream([{ name: 'x', body, size: 9, crc32: crc32(bytesOf('abc')) }])),
    ).rejects.toThrow(/size/);
  });

  it('loads lazy entries one at a time', async () => {
    let live = 0;
    let peak = 0;
    const lazy = (name: string) => ({
      name,
      bytes: async () => {
        live++;
        peak = Math.max(peak, live);
        return randomBytes(1000);
      },
    });
    const reader = zipStream([lazy('a'), lazy('b'), lazy('c')]).getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      live = 0;
    }
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops once maxBytes is exceeded', async () => {
    const entries = [
      { name: 'a', bytes: randomBytes(600) },
      { name: 'b', bytes: randomBytes(600) },
    ];
    await expect(collect(zipStream(entries, { maxBytes: 1000 }))).rejects.toThrow(
      PackageLimitError,
    );
  });
});

describe('.pkpass packaging', () => {
  const signed = {
    files: { 'pass.json': bytesOf('{}'), 'icon.png': randomBytes(50), signature: randomBytes(10) },
    manifest: {},
  };
  it('exports the MIME types', () => {
    expect(PKPASS_CONTENT_TYPE).toBe('application/vnd.apple.pkpass');
    expect(PKPASSES_CONTENT_TYPE).toBe('application/vnd.apple.pkpasses');
  });
  it('streams and returns identical archives, honouring precomputed CRCs', async () => {
    const withCrc = { ...signed, crc32: { 'icon.png': crc32(signed.files['icon.png']) } };
    const streamed = concat(await collect(packagePass(withCrc)));
    expect(streamed).toEqual(packagePassBytes(withCrc));
    expect(streamed).toEqual(packagePassBytes(signed));
  });
});

describe('.pkpasses bundles', () => {
  const pass = (n: number) => ({ name: `p${n}`, bytes: randomBytes(100 + n) });

  it('accepts up to ten passes and names them .pkpass', async () => {
    const passes = Array.from({ length: PKPASSES_MAX_PASSES }, (_, i) => pass(i));
    const files = unzipSync(concat(await collect(packagePasses(passes))));
    expect(Object.keys(files)).toHaveLength(10);
    expect(Object.keys(files).every((n) => n.endsWith('.pkpass'))).toBe(true);
  });

  it('rejects an eleventh pass and an empty bundle', () => {
    expect(() => packagePasses(Array.from({ length: 11 }, (_, i) => pass(i)))).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_PASSES' }),
    );
    expect(() => packagePasses([])).toThrow(PackageLimitError);
  });

  it('rejects declared sizes over 150 MB before reading anything', () => {
    let read = false;
    const lazy = {
      name: 'big',
      size: PKPASSES_MAX_BYTES + 1,
      bytes: async () => {
        read = true;
        return new Uint8Array();
      },
    };
    expect(() => packagePasses([lazy])).toThrow(
      expect.objectContaining({ code: 'BUNDLE_TOO_LARGE' }),
    );
    expect(() =>
      packagePasses([
        { name: 'a', size: 100_000_000, bytes: async () => new Uint8Array() },
        { name: 'b', size: 60_000_000, bytes: async () => new Uint8Array() },
      ]),
    ).toThrow(/150 MB/);
    expect(read).toBe(false);
  });

  it('accepts exactly the limit when sizes are declared', () => {
    expect(() =>
      packagePasses([{ name: 'a', size: PKPASSES_MAX_BYTES, bytes: async () => new Uint8Array() }]),
    ).not.toThrow();
  });

  it('rejects duplicate pass names', async () => {
    await expect(
      collect(packagePasses([pass(1), { ...pass(2), name: 'p1.pkpass' }])),
    ).rejects.toThrow(/Duplicate/);
  });
});
