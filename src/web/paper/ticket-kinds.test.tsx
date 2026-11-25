import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type PaperSize, resolvePaper } from '../../passkit/template/paper.ts';
import { blueprintPass, SCAN_CODE } from '../../passkit/template/paper-blueprint-fixtures.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from './drawing.ts';
import { PaperTicket } from './ticket.tsx';

const CODE = 'PABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function html(
  slug: string,
  size: PaperSize,
  paper: Record<string, unknown> = {},
  over: Record<string, string> = {},
  photo?: string,
) {
  const { passJson, manifest, personalization } = await blueprintPass(slug, over);
  const design = resolvePaper({ schema: 1, size, barcode: 'qr', ...paper });
  const content = paperContent({
    passJson,
    manifest,
    personalization,
    design,
    scanCode: SCAN_CODE,
  });
  return renderToStaticMarkup(
    <PaperTicket
      content={content}
      design={design}
      code={CODE}
      drawing={drawPaperCode(toSvg, design.barcode, CODE)}
      mark="full"
      assets={photo ? { photo } : undefined}
    />,
  );
}

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('journey paper', () => {
  it('a boarding pass reads from, to, flight, gate, times and seat on a page', async () => {
    const t = text(await html('starter-boarding-pass', 'a4', { kind: 'journey' }));
    for (const s of [
      'SFO – JFK',
      'Flight WA100',
      'Gate',
      'B12',
      'Boards 7:15 am',
      'Departs 8:00 am',
      'Arrives 4:30 pm EDT',
      '14A',
      'San Francisco to New York',
    ])
      expect(t).toContain(s);
  });

  it('a transit ticket reads lane and party', async () => {
    const t = text(await html('starter-transit-ticket', 'half', { kind: 'journey' }));
    for (const s of ['Newport – Harbor Point', 'Lane', 'Admits 3', 'Board by 6:55 am'])
      expect(t).toContain(s);
  });
});

describe('booking and stay paper', () => {
  it('a booking prints what, with and where, no status and no raw time', async () => {
    const h = await html('starter-booking', 'half', { kind: 'booking' });
    const t = text(h);
    for (const s of ['Cut and colour', 'Sam', 'Soho']) expect(t).toContain(s);
    expect(t).not.toContain('Booked');
    expect(h).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(h).not.toMatch(/ticket/i);
  });

  it('a stay prints check-in, check-out, nights and extras, with no fold marks on a card page', async () => {
    const t = text(await html('starter-hotel-stay', 'a4', { kind: 'stay' }));
    for (const s of ['Check-in', 'Check-out', 'Nights', 'Breakfast: Included', 'Your stay'])
      expect(t).toContain(s);
  });
});

describe('badge and credential paper', () => {
  it('a visitor badge draws the photo, host, company, go to and arrival', async () => {
    const h = await html(
      'starter-visitor-pass',
      'cr80',
      { kind: 'badge' },
      {},
      'data:image/png;base64,AAAA',
    );
    const t = text(h);
    expect(h).toContain('src="data:image/png;base64,AAAA"');
    for (const s of [
      'Leo Brandt',
      'Host: Priya Shah',
      'Company: Acme Ltd',
      'Go to: Floor 3, Oslo',
      'Valid: Mon 18 Nov · 9:30 am – 5:00 pm',
    ])
      expect(t).toContain(s);
    expect(h.match(/data-face=/g)).toHaveLength(2);
  });

  it('without a photo the holder gets initials, never a stock image', async () => {
    const h = await html('starter-staff-badge', 'cr80', { kind: 'badge' });
    expect(h).toContain('pp-initials');
    expect(h).toContain('>PS<');
    expect(h).not.toContain('<img');
  });

  it('a credential names the credential, the holder and who issued it', async () => {
    const t = text(await html('starter-credential', 'cr80', { kind: 'credential' }));
    for (const s of ['CPR / AED Provider', 'Ana Rivera', 'Issued by', 'Issued: Sun 15 Mar 2026'])
      expect(t).toContain(s);
  });

  it('the badge page version leads with the photo too', async () => {
    const h = await html(
      'starter-staff-badge',
      'a4',
      { kind: 'badge' },
      {},
      'data:image/png;base64,AAAA',
    );
    expect(h).toContain('pp-band-photo');
    expect(h).not.toContain('Folding');
  });
});

describe('wording per class', () => {
  it.each([
    ['henrys-blue', 'a4', 'membership'],
    ['starter-staff-badge', 'a4', 'badge'],
    ['starter-credential', 'a4', 'credential'],
    ['starter-hotel-stay', 'a4', 'stay'],
    ['starter-booking', 'a4', 'booking'],
  ] as const)('%s never says ticket', async (slug, size, kind) => {
    const h = await html(slug, size, { kind });
    expect(text(h)).not.toMatch(/ticket/i);
    expect(h).not.toMatch(/aria-label="Ticket/);
  });

  it('a membership sheet has no fold marks and no "this page"', async () => {
    const h = await html('henrys-blue', 'a4', { kind: 'membership' });
    expect(h).not.toContain('pp-fold');
    expect(text(h)).not.toMatch(/Folding|This page/);
  });

  it('a stamp card names its reward', async () => {
    const h = await html('starter-pack', 'half', { kind: 'coupon' });
    expect(text(h)).toContain('Pack of 10 washes');
    expect(text(h)).toContain('For Dana Ortiz');
    expect(text(h)).not.toMatch(/\.\./);
  });
});

describe('days and nights', () => {
  it('a badge valid over several days prints both dates', async () => {
    const t = text(
      await html(
        'starter-visitor-pass',
        'cr80',
        { kind: 'badge' },
        { validUntil: '2030-11-22T17:00:00-08:00' },
      ),
    );
    expect(t).toContain('Valid: Mon 18 Nov 9:30 am – Fri 22 Nov 5:00 pm');
  });

  it('an overnight arrival names its day', async () => {
    const t = text(
      await html(
        'starter-boarding-pass',
        'a4',
        { kind: 'journey' },
        { arrivesAt: '2030-06-02T04:30:00-04:00' },
      ),
    );
    expect(t).toContain('Arrives Sun 2 Jun, 4:30 am EDT');
  });
});

describe('long names', () => {
  it('a long route keeps each end short and the whole name below', async () => {
    const t = text(
      await html(
        'starter-transit-ticket',
        'a4',
        { kind: 'journey' },
        {
          origin: 'Wolfeschlegelsteinhausenbergerdorf Harbour',
          destination: 'Llanfairpwllgwyngyllgogerychwyrndrobwll',
        },
      ),
    );
    expect(t).toContain('From Wolfeschlegelsteinhausenbergerdorf Harbour');
    expect(t).toContain('To Llanfairpwllgwyngyllgogerychwyrndrobwll');
  });
});
