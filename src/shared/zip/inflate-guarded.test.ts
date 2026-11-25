import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inflateGuarded, ZipError, type ZipLimits } from './inflate-guarded.ts';

const limits: ZipLimits = {
  archiveBytes: 1024 * 1024,
  rawEntries: 5,
  entryBytes: 100_000,
  totalBytes: 150_000,
  ratio: 100,
  ratioFloor: 64 * 1024,
};
const all = () => true;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ZipError);
    return (e as ZipError).code;
  }
  return 'none';
}

describe('inflateGuarded', () => {
  it('inflates only selected entries and lists every name', () => {
    const zip = zipSync({ a: strToU8('aa'), b: strToU8('bb') });
    const out = inflateGuarded(zip, limits, (n) => n === 'b');
    expect([...out.files.keys()]).toEqual(['b']);
    expect(out.names.sort()).toEqual(['a', 'b']);
  });

  it('refuses non-zip, damaged, oversized and crowded archives', () => {
    expect(code(() => inflateGuarded(strToU8('hello world'), limits, all))).toBe('ZIP_NOT_ZIP');
    const zip = zipSync({ a: strToU8('x') });
    expect(code(() => inflateGuarded(zip.slice(0, zip.length - 5), limits, all))).toBe(
      'ZIP_INVALID',
    );
    expect(code(() => inflateGuarded(zip, { ...limits, archiveBytes: 10 }, all))).toBe(
      'ZIP_TOO_LARGE',
    );
    const many = zipSync(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, strToU8('x')])),
    );
    expect(code(() => inflateGuarded(many, limits, all))).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('enforces entry, total and ratio caps', () => {
    const big = zipSync({ a: new Uint8Array(100_001) });
    expect(code(() => inflateGuarded(big, limits, all))).toBe('ZIP_ENTRY_TOO_LARGE');
    const two = zipSync({ a: new Uint8Array(90_000).fill(1), b: new Uint8Array(90_000).fill(2) });
    expect(code(() => inflateGuarded(two, { ...limits, ratio: 100_000 }, all))).toBe(
      'ZIP_TOO_LARGE',
    );
    const squash = zipSync({ a: new Uint8Array(90_000) });
    expect(code(() => inflateGuarded(squash, limits, all))).toBe('ZIP_RATIO');
    expect(code(() => inflateGuarded(squash, limits, () => false))).toBe('none');
  });

  it('throws only ZipError for every truncation', () => {
    const zip = zipSync({ a: strToU8('hello'.repeat(50)), b: strToU8('x') });
    for (let len = 0; len < zip.length; len++)
      code(() => inflateGuarded(zip.slice(0, len), limits, all));
  });
});
