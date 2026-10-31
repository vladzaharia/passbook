import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { basicPackage, makePng, zipOf } from './fixtures.ts';
import { classify, cleanPath, detectPrefix } from './names.ts';
import { extractArchive, ImportError, LIMITS } from './unzip.ts';

const enc = new TextEncoder();

function reject(zip: Uint8Array): string {
  try {
    extractArchive(zip);
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
  return 'accepted';
}

function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function zipRaw(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v, { level: 0 }]])),
  );
}

describe('extractArchive', () => {
  it('extracts a plain package', () => {
    const { files } = extractArchive(zipOf(basicPackage()));
    expect([...files.keys()].sort()).toEqual(['icon.png', 'icon@2x.png', 'pass.json']);
  });

  it('strips one leading .pkpasstemplate folder and drops junk', () => {
    const zip = zipOf({
      'Gym.pkpasstemplate/pass.json': enc.encode('{}'),
      'Gym.pkpasstemplate/icon.png': makePng(38, 38),
      'Gym.pkpasstemplate/.DS_Store': enc.encode('x'),
      'Gym.pkpasstemplate/manifest.json': enc.encode('{}'),
      'Gym.pkpasstemplate/signature': enc.encode('x'),
      '__MACOSX/Gym.pkpasstemplate/._pass.json': enc.encode('x'),
    });
    const { files, dropped } = extractArchive(zip);
    expect([...files.keys()].sort()).toEqual(['icon.png', 'pass.json']);
    expect(dropped.length).toBe(4);
  });

  it('rejects non-zip input and truncated archives', () => {
    expect(reject(enc.encode('not a zip at all'))).toBe('NOT_A_ZIP');
    expect(reject(zipOf(basicPackage()).subarray(0, 40))).toBe('ZIP_INVALID');
  });

  it('rejects path traversal, absolute paths, backslashes and NUL bytes', () => {
    const one = (name: string) => reject(zipRaw({ [name]: enc.encode('x') }));
    expect(one('../evil.png')).toBe('PATH_TRAVERSAL');
    expect(one('a/../../evil.png')).toBe('PATH_TRAVERSAL');
    expect(one('/etc/passwd')).toBe('PATH_ABSOLUTE');
    expect(one('C:/x.png')).toBe('PATH_ABSOLUTE');
    expect(one('a\\b.png')).toBe('PATH_BACKSLASH');
    expect(one('icon.png\0.exe')).toBe('PATH_NUL');
  });

  it('rejects case-insensitive duplicates', () => {
    expect(reject(zipRaw({ 'icon.png': makePng(38, 38), 'ICON.png': makePng(38, 38) }))).toBe(
      'PATH_DUPLICATE',
    );
  });

  it('rejects more than 100 files', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < LIMITS.entries + 1; i++) files[`f${i}.png`] = enc.encode('x');
    expect(reject(zipRaw(files))).toBe('TOO_MANY_ENTRIES');
  });

  it('rejects entries over 5 MB and archives over 15 MB expanded', () => {
    const big = new Uint8Array(LIMITS.entryBytes + 1);
    expect(reject(zipOf({ 'a.png': big }))).toBe('ENTRY_TOO_LARGE');
    const four = noise(4 * 1024 * 1024);
    expect(reject(zipOf({ 'a.png': four, 'b.png': four, 'c.png': four, 'd.png': four }))).toBe(
      'ARCHIVE_TOO_LARGE',
    );
  });

  it('rejects an archive over 15 MB before reading it', () => {
    const huge = new Uint8Array(LIMITS.archiveBytes + 1);
    huge.set([0x50, 0x4b, 3, 4]);
    expect(reject(huge)).toBe('ARCHIVE_TOO_LARGE');
  });

  it('rejects a zip bomb by declared ratio without inflating it', () => {
    // 4 MB of zeros deflates to a few KB: ratio far above the cap.
    const zip = zipOf({ 'a.png': new Uint8Array(4 * 1024 * 1024) });
    expect(zip.length).toBeLessThan(10_000);
    expect(reject(zip)).toBe('COMPRESSION_RATIO');
  });

  it('rejects an entry that inflates past a lying header', () => {
    const zip = zipOf({ 'a.png': new Uint8Array(40 * 1024 * 1024) });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1000, true);
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 1000, true);
    }
    const started = performance.now();
    expect(reject(zip)).toBe('ZIP_INVALID');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('names', () => {
  it('detects the single wrapper folder only', () => {
    expect(detectPrefix(['A.pkpasstemplate/pass.json', 'A.pkpasstemplate/icon.png'])).toBe(
      'A.pkpasstemplate',
    );
    expect(detectPrefix(['pass.json', 'A.pkpasstemplate/icon.png'])).toBeNull();
    expect(detectPrefix(['x/pass.json'])).toBeNull();
    expect(cleanPath('A.pkpasstemplate/', 'A.pkpasstemplate')).toBeNull();
  });

  it('classifies the allowlist', () => {
    expect(classify('pass.json')).toEqual({ kind: 'pass' });
    expect(classify('icon@3x.png')).toEqual({ kind: 'image', slot: 'icon', scale: 3 });
    expect(classify('en.lproj/pass.strings')).toEqual({ kind: 'strings', locale: 'en' });
    expect(classify('zh-Hans.lproj/logo@2x.png')).toEqual({
      kind: 'image',
      slot: 'logo',
      scale: 2,
      locale: 'zh-Hans',
    });
    for (const bad of [
      'icon@4x.png',
      'icon.jpg',
      'script.js',
      'a/b/pass.strings',
      'en.lproj/x.txt',
      'not locale.lproj/pass.strings',
      'Icon.png',
      'pass.json.bak',
    ])
      expect(classify(bad), bad).toBeNull();
  });
});
