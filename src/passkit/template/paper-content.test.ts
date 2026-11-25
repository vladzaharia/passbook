import { describe, expect, it } from 'vitest';
import { DERIVED_PAPER, type PaperKind, resolvePaper } from './paper.ts';
import { blueprintPass, SCAN_CODE } from './paper-blueprint-fixtures.ts';
import { paperContent } from './paper-content.ts';
import { paperDate, paperZoneInfo, paperZoneOf } from './paper-format.ts';
import { paperInk } from './paper-ink.ts';

const IMAGES = ['logo', 'artwork', 'thumbnail', 'strip'];

async function contentOf(slug: string, kind?: PaperKind, over = {}, paper: object = {}) {
  const { passJson, manifest, personalization } = await blueprintPass(slug, over);
  const design = resolvePaper({
    schema: 1,
    size: 'a4',
    barcode: 'qr',
    ...(kind ? { kind } : {}),
    ...paper,
  });
  const content = paperContent({
    passJson,
    manifest,
    personalization,
    design,
    holderName: 'Fallback Name',
    scanCode: SCAN_CODE,
    images: IMAGES,
  });
  return { content, personalization, passJson };
}

describe('paper content per class', () => {
  it('admission: an event leads with title, times and seat boxes', async () => {
    const { content } = await contentOf('starter-event-ticket', 'admission', {
      seat: 'B-4-12',
    });
    expect(content).toMatchObject({
      kind: 'admission',
      kicker: 'Event ticket',
      title: 'Sample Event',
      start: '2030-06-01T19:00:00-07:00',
      doors: '2030-06-01T18:00:00-07:00',
      end: '2030-06-01T22:00:00-07:00',
      zone: 'America/Los_Angeles',
      venue: 'Sample Hall',
      holder: 'Alex Morgan',
      art: 'artwork',
      noun: 'ticket',
    });
    expect(content.bring).toEqual(['This page or your phone ticket']);
    expect(content.terms).toContain('No re-entry');
  });

  it('admission: a day pass has no clock and says pass', async () => {
    const { content } = await contentOf('starter-day-pass', 'admission');
    expect(content).toMatchObject({ kind: 'admission', kicker: 'Day pass', noun: 'pass' });
    expect(content.start).toBeUndefined();
    expect(content.bring).toEqual(['This page or your phone pass']);
  });

  it('membership: the member leads, the club and tier follow', async () => {
    const { content } = await contentOf('henrys-blue', 'membership');
    expect(content).toMatchObject({
      kind: 'membership',
      title: 'Alex Morgan',
      type: 'All-Inclusive Wellness',
      venue: 'Capitol Hill',
      noun: 'pass',
    });
    expect(content.help).toContain('(206) 644-7797');
  });

  it('permit: the zone is the hero and the bay a fact', async () => {
    const { content } = await contentOf('starter-permit', 'permit');
    expect(content).toMatchObject({ kind: 'permit', hero: { zone: 'C' }, type: 'Monthly' });
    expect(content.facts).toEqual([{ label: 'Bay', text: '14' }]);
    expect(content.validUntil).toBeDefined();
  });

  it('coupon: the offer is the hero and the strip is the art', async () => {
    const { content } = await contentOf('starter-coupon', 'coupon');
    expect(content).toMatchObject({ kind: 'coupon', hero: { offer: '20% off' }, art: 'strip' });
    expect(content.validUntil).toBeDefined();
    expect(content.holder).toBeUndefined();
  });

  it('pickup: the name is the hero, the counter code and items are facts, ID is asked on a flag', async () => {
    const plain = await contentOf('starter-pickup', 'pickup');
    expect(plain.content).toMatchObject({
      kind: 'pickup',
      hero: { name: 'Mia Kent' },
      room: 'Bay 3',
    });
    expect(plain.content.items).toEqual(['2 mains', '1 side']);
    expect(plain.content.facts.map((f) => f.label)).toEqual(['Counter code', 'Items']);
    expect(plain.content.bring).toEqual(['This page or your phone pass']);
    const flagged = await contentOf('starter-pickup', 'pickup', { idRequired: true });
    expect(flagged.content.bring).toEqual([
      'This page or your phone pass',
      'Photo ID in the name Mia Kent',
    ]);
  });

  it('derives the class when the block names none', async () => {
    const kinds: Record<string, PaperKind> = {
      'starter-event-ticket': 'admission',
      'starter-permit': 'permit',
      'starter-coupon': 'coupon',
      'starter-pickup': 'pickup',
      'starter-store-card': 'membership',
    };
    for (const [slug, kind] of Object.entries(kinds)) {
      const { passJson, manifest, personalization } = await blueprintPass(slug);
      expect(
        paperContent({ passJson, manifest, personalization, design: DERIVED_PAPER }).kind,
      ).toBe(kind);
    }
  });

  it('adds up to four bring lines from the design, one per line', async () => {
    const { content } = await contentOf(
      'starter-event-ticket',
      'admission',
      {},
      {
        bring: 'Small bags only\nEarplugs\nWater bottle\nUmbrella',
      },
    );
    expect(content.bring).toHaveLength(4);
    expect(content.bring[1]).toBe('Small bags only');
  });
});

describe('credential guards', () => {
  const every = [
    'starter-event-ticket',
    'starter-day-pass',
    'henrys-blue',
    'starter-permit',
    'starter-coupon',
    'starter-pickup',
  ];

  it.each(every)(
    '%s never carries the scan code, serial, barcode text or lookup value',
    async (slug) => {
      const { content, personalization, passJson } = await contentOf(slug);
      const json = JSON.stringify(content);
      const lookup = (passJson as { barcodes?: { altText?: string }[] }).barcodes?.[0]?.altText;
      expect(json).not.toContain(SCAN_CODE);
      expect(json).not.toContain('SER-0001');
      const { manifest } = await blueprintPass(slug);
      const scan = (manifest.scan as { lookup?: { input?: string; public?: boolean } } | undefined)
        ?.lookup;
      // A template that declares its lookup public (a permit's plate) may print it; no other does.
      if (scan?.public) return;
      if (lookup) expect(json).not.toContain(lookup);
      const value = scan?.input ? String(personalization[scan.input] ?? '') : '';
      if (value.length > 2) expect(json).not.toContain(value);
    },
  );

  it('keeps the pickup order number (the lookup) off the sheet', async () => {
    const { content } = await contentOf('starter-pickup', 'pickup', {}, { fields: ['order'] });
    expect(JSON.stringify(content)).not.toContain('1042');
  });
});

describe('scan.lookup.public', () => {
  const permit = async (isPublic: boolean | undefined) => {
    const { passJson, manifest, personalization } = await blueprintPass('starter-permit', {
      plate: 'LK73 VHM',
    });
    const scan = {
      ...manifest.scan,
      lookup: { input: 'plate', ...(isPublic === undefined ? {} : { public: isPublic }) },
    };
    return paperContent({
      passJson,
      manifest: { ...manifest, scan } as typeof manifest,
      personalization,
      design: resolvePaper({ schema: 1, size: 'half', barcode: 'qr', kind: 'permit' }),
      scanCode: SCAN_CODE,
    });
  };

  it('prints the plate when the template declares its lookup public', async () => {
    expect((await permit(true)).hero).toEqual({ zone: 'C', plate: 'LK73 VHM' });
  });

  it('keeps the plate off the sheet when it is not declared, or declared false', async () => {
    for (const declared of [undefined, false]) {
      const content = await permit(declared);
      expect(content.hero?.plate).toBeUndefined();
      expect(JSON.stringify(content)).not.toContain('LK73 VHM');
    }
  });

  it('never prints the scan code or serial, public or not', async () => {
    const json = JSON.stringify(await permit(true));
    expect(json).not.toContain(SCAN_CODE);
    expect(json).not.toContain('SER-0001');
  });
});

describe('ink', () => {
  it('prints colour for a strong band and mono for a pastel one (pickup)', async () => {
    expect((await contentOf('starter-event-ticket')).content.ink).toBe('colour');
    expect((await contentOf('starter-pickup')).content.ink).toBe('mono');
  });

  it('honours ink: mono even for a strong band', async () => {
    const { content } = await contentOf('starter-event-ticket', undefined, {}, { ink: 'mono' });
    expect(content.ink).toBe('mono');
  });

  it('fails the greyscale check on a pastel band and on equal greys', () => {
    expect(
      paperInk({ backgroundColor: 'rgb(206,242,226)', foregroundColor: 'rgb(12,52,38)' }).colour,
    ).toBe(false);
    // Different hues, the same grey: readable in colour, not in black and white.
    expect(
      paperInk({ backgroundColor: 'rgb(160,60,60)', foregroundColor: 'rgb(90,110,0)' }).colour,
    ).toBe(false);
    expect(
      paperInk({ backgroundColor: 'rgb(94,6,54)', foregroundColor: 'rgb(255,255,255)' }).colour,
    ).toBe(true);
  });
});

describe('times with their zone', () => {
  it('prints the zone abbreviation on every time', () => {
    expect(paperDate('2027-02-13T19:30:00+13:00', 'Pacific/Auckland', 'timeZone')).toBe(
      '7:30 pm NZDT',
    );
    expect(paperDate('2027-02-13T19:30:00+13:00', 'Pacific/Auckland', 'short')).toBe(
      'Sat 13 Feb 2027',
    );
    expect(paperDate('2027-02-13T19:30:00+13:00', 'Pacific/Auckland', 'stamp')).toBe(
      '13 Feb 2027, 7:30 pm NZDT',
    );
    expect(paperZoneInfo('Pacific/Auckland', '2027-02-13T19:30:00+13:00')).toEqual({
      abbr: 'NZDT',
      name: 'New Zealand Time',
    });
  });

  it('takes the zone from the template input, else from the offset in the time', async () => {
    expect(paperZoneOf('2027-04-12T19:30:00-05:00')).toBe('-05:00');
    expect(paperZoneOf('2027-04-12T19:30:00Z')).toBeUndefined();
    expect(paperZoneOf('2027-04-12T19:30:00', 'Mars/Base')).toBeUndefined();
    const { content } = await contentOf('starter-event-ticket', 'admission', {
      venueTimeZone: 'Pacific/Auckland',
    });
    expect(content.zone).toBe('Pacific/Auckland');
  });
});

describe('venue is said once', () => {
  it('never repeats the venue, room or address across lines', async () => {
    const { content } = await contentOf('starter-event-ticket', 'admission', {
      venueName: 'Grand Hall',
      venueRoom: 'Grand Hall',
      venueRegion: 'Grand Hall, Portland',
    });
    const lines = [content.venue, content.address, content.room].filter(Boolean) as string[];
    expect(new Set(lines).size).toBe(lines.length);
    expect(JSON.stringify(content)).toContain('Portland');
    expect(
      JSON.stringify([content.venue, content.address, content.room]).match(/Grand Hall/g),
    ).toHaveLength(1);
  });
});
