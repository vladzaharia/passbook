import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PaperKind, PaperSize } from '../../../passkit/template/paper.ts';
import { makePng } from './pdf-png-fixtures.ts';
import { pdfText, readPdf } from './pdf-read.ts';
import { renderPdf } from './pdf-render.ts';
import { SAMPLE_CODE, sheet } from './pdf-render-fixtures.ts';

const text = async (kind: PaperKind, size: PaperSize) =>
  pdfText(await renderPdf([sheet(kind, size)], { assets: env.ASSETS }));

describe('the PDF of each new class says what the page says', () => {
  it('a boarding pass: from, to, flight, times, seat and gate', async () => {
    const t = await text('journey', 'a4');
    for (const want of [
      'SFO – JFK',
      'Flight WA100',
      'San Francisco to New York',
      'Boards 7:15 am',
      'Departs 8:00 am',
      'GATE',
      'B12',
      '14A',
      'At the gate',
    ])
      expect(t).toContain(want);
    expect(t.replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it('a booking: what, with, where and status, in one page with no ticket words', async () => {
    const t = await text('booking', 'half');
    for (const want of ['Cut and colour', 'Sam', 'Soho', 'Booked']) expect(t).toContain(want);
    expect(t).not.toMatch(/ticket/i);
  });

  it('a stay: check-in, check-out, nights and extras', async () => {
    const t = await text('stay', 'a4');
    for (const want of ['Check-in', 'Check-out', 'Breakfast: Included', 'Your stay'])
      expect(t).toContain(want);
  });

  it('keeps the title clear of the logo on a long route', async () => {
    const long = 'Wolfeschlegelsteinhausenbergerdorf – Llanfairpwllgwyngyll';
    const bytes = await renderPdf([sheet('journey', 'half', { content: { title: long } })], {
      assets: env.ASSETS,
    });
    const [page] = await readPdf(bytes);
    expect(page).toBeDefined();
    expect(await pdfText(bytes)).toContain('Wolfeschlegelsteinhausen');
  });

  it.each([
    ['cr80', 85.6, 54],
    ['cr80p', 54, 85.6],
  ] as const)(
    'a visitor badge on %s: two faces at card size, host and arrival, no ticket words',
    async (size, w, h) => {
      const bytes = await renderPdf([sheet('badge', size)], { assets: env.ASSETS });
      const pages = await readPdf(bytes);
      expect(pages).toHaveLength(2);
      for (const p of pages) {
        expect(p.size.w).toBeCloseTo(w * (72 / 25.4), 0);
        expect(p.size.h).toBeCloseTo(h * (72 / 25.4), 0);
      }
      const t = await pdfText(bytes);
      for (const want of [
        'Leo Brandt',
        'Host: Priya Shah',
        'Company: Acme Ltd',
        'Go to: Floor 3, Oslo',
        'LB',
      ])
        expect(t).toContain(want);
      expect(t).not.toMatch(/ticket/i);
      expect(t.replace(/\s/g, '')).toContain(SAMPLE_CODE);
    },
  );

  it('draws the member photo when the sheet has one', async () => {
    const png = makePng({ width: 32, height: 32, type: 2 });
    const withPhoto = await renderPdf(
      [sheet('badge', 'cr80', { images: { photo: { id: 'p1', bytes: png } } })],
      { assets: env.ASSETS },
    );
    const without = await renderPdf([sheet('badge', 'cr80')], { assets: env.ASSETS });
    expect(withPhoto.length).toBeGreaterThan(without.length);
    expect(await pdfText(withPhoto)).not.toContain('LB');
  });

  it('a credential on a card names the credential and who issued it', async () => {
    const t = await text('credential', 'cr80');
    for (const want of ['Ana Rivera', 'CPR / AED Provider', 'Issued by']) expect(t).toContain(want);
  });
});
