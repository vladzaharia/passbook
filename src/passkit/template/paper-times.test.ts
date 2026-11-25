import { describe, expect, it } from 'vitest';
import { faceLines } from '../../web/paper/ticket-text.ts';
import { paperManifestIssues, resolvePaper } from './paper.ts';
import { blueprintPass } from './paper-blueprint-fixtures.ts';
import { paperContent } from './paper-content.ts';
import { paperDate } from './paper-format.ts';

async function printed(slug: string, over = {}) {
  const { passJson, manifest, personalization } = await blueprintPass(slug, over);
  const content = paperContent({
    passJson,
    manifest,
    personalization,
    design: resolvePaper(manifest.paper),
  });
  const at = (iso: string | undefined) =>
    iso ? paperDate(iso, content.zone, 'timeZone') : undefined;
  return { content, start: at(content.start), end: at(content.end), manifest, passJson };
}

describe('paper prints the real start, never the lock-screen date', () => {
  it.each([
    ['starter-timed-ticket', '2:00 pm EST', '2:30 pm EST', 'America/New_York'],
    ['starter-boarding-pass', '8:00 am GMT-7', undefined, '-07:00'],
    ['starter-transit-ticket', '7:15 am EST', undefined, 'America/New_York'],
    ['starter-booking', '9:30 am GMT-5', undefined, '-05:00'],
    ['starter-visitor-pass', '9:30 am GMT-8', undefined, '-08:00'],
    ['starter-hotel-stay', '3:00 pm GMT-8', '11:00 am GMT-8', '-08:00'],
  ])('%s starts %s, ends %s', async (slug, start, end, zone) => {
    const out = await printed(slug);
    expect(out.start).toBe(start);
    expect(out.end).toBe(end);
    expect(out.content.zone).toBe(zone);
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

describe('the one-use line follows the check-in rule', () => {
  it('a single-use ticket says once, a repeating pass does not', async () => {
    expect((await printed('starter-event-ticket')).content.once).toBe(true);
    expect((await printed('starter-day-pass')).content.once).toBe(false);
    expect((await printed('starter-multi-day-pass')).content.once).toBe(false);
  });
});

describe('fields a layout does not draw', () => {
  it('warns on a card, permit or coupon', async () => {
    const { manifest, passJson } = await printed('starter-permit');
    const withFields = (paper: object) =>
      paperManifestIssues({ ...manifest, paper } as never, { passJson }).filter(
        (i) => i.code === 'PAPER_FIELD' && i.path === 'paper.fields',
      );
    expect(withFields({ schema: 1, size: 'cr80', barcode: 'qr', fields: ['zone'] })).toHaveLength(
      1,
    );
    expect(
      withFields({ schema: 1, size: 'half', barcode: 'qr', kind: 'permit', fields: ['zone'] }),
    ).toHaveLength(1);
    expect(
      withFields({ schema: 1, size: 'a4', barcode: 'qr', kind: 'admission', fields: ['zone'] }),
    ).toHaveLength(0);
  });

  it('caps the extras on the holder panel', async () => {
    const { content } = await printed('starter-event-ticket');
    const extras = Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, text: `v${i}` }));
    expect(faceLines({ ...content, extras }).length).toBeLessThanOrEqual(9);
    expect(faceLines({ ...content, extras }, true).length).toBeLessThanOrEqual(6);
  });
});

describe('an end on another day carries its date', () => {
  it('a hotel checkout names the day', async () => {
    const { content } = await printed('starter-hotel-stay');
    expect(
      faceLines(content)
        .map((l) => l.text)
        .join('\n'),
    ).toContain('Ends Thu 21 Nov 2030, 11:00 am');
  });
});
