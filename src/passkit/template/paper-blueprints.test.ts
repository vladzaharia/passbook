import { describe, expect, it } from 'vitest';
import { type PaperKind, paperManifestIssues, resolvePaper } from './paper.ts';
import { blueprintPass, SCAN_CODE } from './paper-blueprint-fixtures.ts';
import { paperContent } from './paper-content.ts';

const BLUEPRINTS: [string, PaperKind, string][] = [
  ['starter-event-ticket', 'admission', 'a4'],
  ['starter-timed-ticket', 'admission', 'a4'],
  ['starter-day-pass', 'admission', 'a4'],
  ['starter-guest-pass', 'admission', 'a4'],
  ['starter-id-card', 'membership', 'cr80'],
  ['starter-monthly-pass', 'membership', 'a4'],
  ['starter-store-card', 'membership', 'cr80'],
  ['henrys-blue', 'membership', 'cr80'],
  ['henrys-copper', 'membership', 'cr80'],
  ['starter-permit', 'permit', 'half'],
  ['starter-coupon', 'coupon', 'half'],
  ['starter-pickup', 'pickup', 'a4'],
];

describe.each(BLUEPRINTS)('%s paper defaults', (slug, kind, size) => {
  it(`is a ${kind} on ${size}, valid, and prints from its sample`, async () => {
    const { passJson, manifest, personalization } = await blueprintPass(slug);
    const design = resolvePaper(manifest.paper);
    expect(design).toMatchObject({ kind, size, derived: false });
    expect(paperManifestIssues(manifest, { passJson })).toEqual([]);
    const content = paperContent({
      passJson,
      manifest,
      personalization,
      design,
      scanCode: SCAN_CODE,
    });
    expect(content.kind).toBe(kind);
    expect(content.title).not.toBe('');
    expect(JSON.stringify(content)).not.toContain(SCAN_CODE);
  });
});

describe('blueprint specifics', () => {
  it('a permit declares its plate public and prints it, so the permit is useful on a dashboard', async () => {
    const { passJson, manifest, personalization } = await blueprintPass('starter-permit');
    expect((manifest.scan as { lookup?: { public?: boolean } }).lookup?.public).toBe(true);
    const design = resolvePaper(manifest.paper);
    const content = paperContent({ passJson, manifest, personalization, design });
    expect(content.hero?.plate).toBe(String(personalization.plate));
  });

  it('an order pickup never prints its order number, which is its lookup', async () => {
    const { passJson, manifest, personalization } = await blueprintPass('starter-pickup', {
      orderNo: '774411',
    });
    const content = paperContent({
      passJson,
      manifest,
      personalization,
      design: resolvePaper(manifest.paper),
    });
    expect((manifest.scan as { lookup?: { public?: boolean } }).lookup?.public).toBeUndefined();
    expect(JSON.stringify(content)).not.toContain('774411');
    expect(content.ink).toBe('mono');
  });

  it('a coupon draws Code 128 for a till scanner', async () => {
    const { manifest } = await blueprintPass('starter-coupon');
    expect(resolvePaper(manifest.paper).barcode).toBe('code128');
  });

  it('a day pass asks for ID only when it says so', async () => {
    const { passJson, manifest, personalization } = await blueprintPass('starter-day-pass');
    const content = paperContent({
      passJson,
      manifest,
      personalization,
      design: resolvePaper(manifest.paper),
    });
    expect(content.bring).toEqual(['This page or your phone pass', 'Photo ID if asked']);
  });
});
