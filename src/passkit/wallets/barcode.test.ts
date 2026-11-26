import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import { GOOGLE_COMPILERS, googleCompiler } from './google/compilers.ts';
import { googleView } from './google/fixtures.ts';
import { attributes, compile as compileSamsung, view as samsungView } from './samsung/fixtures.ts';
import type { BarcodeKind, WalletPassView } from './types.ts';
import { NOW } from './view-fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

const OPTIONS = { now: NOW, omit: [] };
const apple = (v: WalletPassView): string | undefined => v.barcodes[0]?.message;
const googleValue = (v: WalletPassView): string | undefined =>
  (googleCompiler.compile(v, OPTIONS).objectBody as { barcode?: { value: string } }).barcode?.value;
const samsungValue = (v: WalletPassView): string | undefined =>
  attributes(compileSamsung(v))['barcode.value'];

/** Messages that must pass through untouched: padding, case, spaces, symbols and non-ASCII. */
const ODD: [BarcodeKind, string][] = [
  ['qr', 'https://wallet.example/p/abc?x=1&y=%20z'],
  ['qr', ' lead and trail  '],
  ['qr', 'Zoë 😀 ✓'],
  ['pdf417', 'LINE1\nLINE2'],
  ['aztec', '0000012345'],
  ['code128', 'Abc-123 xyz'],
  ['code39', 'ABC-123 $/+%'],
  ['ean13', '5901234123457'],
];

describe("scan parity: a wallet barcode message is Apple's", () => {
  it.each(bakedSlugs())('%s: Google and Samsung carry the first Apple message', async (slug) => {
    const g = await googleView(slug);
    const s = await samsungView(slug);
    const message = apple(g);
    expect(message).toBeTruthy();
    expect(apple(s)).toBe(message);
    expect(googleValue(g)).toBe(message);
    expect(samsungValue(s)).toBe(message);
  });

  it('every Google type that draws a code copies the message', async () => {
    for (const slug of bakedSlugs()) {
      const g = await googleView(slug);
      for (const compiler of Object.values(GOOGLE_COMPILERS)) {
        const out = compiler.compile(g, OPTIONS);
        const value = (out.objectBody as { barcode?: { value: string } } | undefined)?.barcode
          ?.value;
        if (value !== undefined) expect(value, `${slug} ${out.type}`).toBe(apple(g));
      }
    }
  });

  it.each(ODD)('%s message %j is copied byte for byte', async (kind, message) => {
    const patch = (v: WalletPassView) => {
      v.barcodes = [{ format: `PKBarcodeFormat-${kind}`, kind, message, encoding: 'utf-8' }];
    };
    const g = await googleView('starter-store-card', { patch });
    const s = await samsungView('starter-store-card');
    patch(s);
    expect(googleValue(g)).toBe(message);
    expect(samsungValue(s)).toBe(message);
  });

  it('a voided pass sends no Google code', async () => {
    const g = await googleView('starter-store-card', {
      patch: (v) => {
        v.validity.voided = true;
      },
    });
    expect(googleValue(g)).toBeUndefined();
  });
});
