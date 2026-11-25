import { describe, expect, it } from 'vitest';
import { endsText, faceLines, rangeText } from '../../web/paper/ticket-text.ts';
import { paperManifestIssues, resolvePaper } from './paper.ts';
import { blueprintPass } from './paper-blueprint-fixtures.ts';
import { paperContent } from './paper-content.ts';
import { paperDate, paperZoneFor } from './paper-format.ts';

async function printed(slug: string, over = {}, orgTimeZone?: string, late = {}) {
  const { passJson, manifest, personalization } = await blueprintPass(slug, over);
  const content = paperContent({
    passJson,
    manifest,
    personalization: { ...personalization, ...late },
    design: resolvePaper(manifest.paper),
    ...(orgTimeZone ? { orgTimeZone } : {}),
  });
  const at = (iso: string | undefined) =>
    iso ? paperDate(iso, paperZoneFor(content, iso), 'timeZone') : undefined;
  const text = faceLines(content)
    .map((l) => l.text)
    .join('\n');
  return { content, start: at(content.start), end: at(content.end), manifest, passJson, text };
}

describe('paper prints the real start, never the lock-screen date', () => {
  it.each([
    ['starter-timed-ticket', '2:00 pm EST', '2:30 pm EST', 'America/New_York'],
    ['starter-boarding-pass', '8:00 am PDT', undefined, 'America/Los_Angeles'],
    ['starter-transit-ticket', '7:15 am EST', undefined, 'America/New_York'],
    ['starter-booking', '9:30 am GMT-5', undefined, '-05:00'],
    ['starter-hotel-stay', '3:00 pm GMT-8', '11:00 am GMT-8', '-08:00'],
  ])('%s starts %s, ends %s', async (slug, start, end, zone) => {
    const out = await printed(slug);
    expect(out.start).toBe(start);
    expect(out.end).toBe(end);
    expect(out.content.zone).toBe(zone);
  });

  it('a visitor pass keeps its validity: no start, valid until 5:00 pm', async () => {
    const { content } = await printed('starter-visitor-pass');
    expect(content.start).toBeUndefined();
    expect(content.validFrom).toBeUndefined();
    expect(content.validUntil).toBe('2030-11-18T17:00:00-08:00');
    expect(endsText(content)).toBe('18 Nov, 5:00 pm GMT-8');
  });

  it('a booking is titled by what it is, not by its timestamp', async () => {
    const { content } = await printed('starter-booking');
    expect(content.title).toBe('Cut and colour');
  });

  it('keeps an event ticket on its semantic start', async () => {
    const { content } = await printed('starter-event-ticket');
    expect(content.start).toBe('2030-06-01T19:00:00-07:00');
  });
});

describe('validity-only templates print what they printed before', () => {
  it.each([
    ['starter-staff-badge', undefined],
    ['starter-guest-pass', undefined],
    ['starter-day-pass', undefined],
    ['starter-access-card', '2030-01-01T00:00:00Z'],
    ['starter-permit', '2030-12-31T00:00:00Z'],
  ])('%s has no start, end or range start; until %s', async (slug, until) => {
    const { content } = await printed(slug);
    expect(content.start).toBeUndefined();
    expect(content.end).toBeUndefined();
    expect(content.validFrom).toBeUndefined();
    expect(content.validUntil).toBe(until);
  });

  it('a permit across a clock change prints each end in its own offset', async () => {
    const { content } = await printed('starter-permit', {
      validFrom: '2030-06-01T00:00:00-07:00',
      validTo: '2030-12-31T23:59:00-08:00',
    });
    expect(rangeText({ ...content, validFrom: '2030-06-01T00:00:00-07:00' })).toBe(
      '1 Jun – 31 Dec 2030',
    );
    expect(endsText(content)).toBe('31 Dec, 11:59 pm GMT-8');
  });
});

describe('times keep their own zone', () => {
  it('a hotel stay across the end of daylight time labels the checkout', async () => {
    const { text } = await printed('starter-hotel-stay', {
      checkIn: '2030-11-02T15:00:00-07:00',
      checkOut: '2030-11-04T11:00:00-08:00',
    });
    expect(text).toContain('Check-in Sat 2 Nov · 3:00 pm');
    expect(text).toContain('Check-out Mon 4 Nov · 11:00 am GMT-8');
  });

  it('a New York day that springs forward labels the end EDT', async () => {
    const { text } = await printed('starter-timed-ticket', {
      startsAt: '2030-03-10T01:00:00-05:00',
      endsAt: '2030-03-10T03:30:00-04:00',
    });
    expect(text).toContain('Starts 1:00 am · Ends 3:30 am EDT (EST)');
  });

  it('a time written in UTC reads in the org zone, and says so', async () => {
    const { content, start } = await printed('starter-booking', {}, 'America/New_York', {
      startsAt: '2030-11-24T14:30:00Z',
    });
    expect(content).toMatchObject({ zone: 'America/New_York', zoneNamed: true });
    expect(start).toBe('9:30 am EST');
  });

  it('a template zone wins over the org zone', async () => {
    const { content } = await printed('starter-timed-ticket', {}, 'Asia/Tokyo');
    expect(content.zone).toBe('America/New_York');
  });
});

describe('the one-use line follows the check-in rule', () => {
  it('says once only when every check-in action admits once', async () => {
    expect((await printed('starter-event-ticket')).content.once).toBe(true);
    expect((await printed('starter-day-pass')).content.once).toBe(false);
    expect((await printed('starter-multi-day-pass')).content.once).toBe(false);
    expect((await printed('starter-hotel-stay')).content.once).toBe(false);
  });
});

describe('fields a layout does not draw', () => {
  const withFields = (manifest: object, passJson: unknown, paper: object) =>
    paperManifestIssues({ ...manifest, paper } as never, { passJson }).filter(
      (i) => i.code === 'PAPER_FIELD_UNDRAWN',
    );

  it('warns on a card, a permit or a coupon, declared or derived', async () => {
    const permit = await printed('starter-permit');
    const base = { schema: 1, barcode: 'qr', fields: ['zone'] };
    expect(withFields(permit.manifest, permit.passJson, { ...base, size: 'cr80' })).toHaveLength(1);
    expect(
      withFields(permit.manifest, permit.passJson, { ...base, size: 'half', kind: 'permit' }),
    ).toHaveLength(1);
    const pack = await printed('starter-pack');
    expect(withFields(pack.manifest, pack.passJson, { ...base, size: 'a4' })).toHaveLength(1);
    expect(
      withFields(permit.manifest, permit.passJson, { ...base, size: 'a4', kind: 'admission' }),
    ).toHaveLength(0);
  });

  it('caps the extras on the holder panel', async () => {
    const { content } = await printed('starter-event-ticket');
    const extras = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, text: `v${i}` }));
    expect(faceLines({ ...content, extras }).length).toBeLessThanOrEqual(7);
    expect(faceLines({ ...content, extras }, true).length).toBeLessThanOrEqual(6);
  });
});

describe('an end on another day carries its date', () => {
  it('a hotel checkout names the day', async () => {
    const { text } = await printed('starter-hotel-stay');
    expect(text).toContain('Check-out Thu 21 Nov · 11:00 am');
  });
});
