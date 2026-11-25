import { describe, expect, it } from 'vitest';
import { resolvePaper, withKind } from './paper.ts';
import { blueprintPass, SCAN_CODE } from './paper-blueprint-fixtures.ts';
import { paperContent } from './paper-content.ts';

async function content(slug: string) {
  const { passJson, manifest, personalization } = await blueprintPass(slug);
  const design = resolvePaper(manifest.paper);
  const c = paperContent({
    passJson,
    manifest,
    personalization,
    design,
    scanCode: SCAN_CODE,
    images: ['logo', 'thumbnail', 'artwork'],
  });
  return { c, manifest, design };
}

/** Every blueprint without a paper block, with the class it derives. */
const DERIVED = [
  ['starter-boarding-pass', 'journey'],
  ['starter-transit-ticket', 'journey'],
  ['starter-booking', 'booking'],
  ['starter-hotel-stay', 'stay'],
  ['starter-staff-badge', 'badge'],
  ['starter-visitor-pass', 'badge'],
  ['starter-access-card', 'badge'],
  ['starter-credential', 'credential'],
  ['starter-multi-day-pass', 'admission'],
  ['starter-generic', 'membership'],
  ['starter-poster-generic', 'membership'],
  ['starter-pack', 'coupon'],
] as const;

describe('derived classes', () => {
  it.each(DERIVED)('%s is %s', async (slug, kind) => {
    const { c } = await content(slug);
    expect(c.kind).toBe(kind);
    expect(JSON.stringify(c)).not.toContain(SCAN_CODE);
  });

  it('an ID class is staff-only unless its block says otherwise', async () => {
    const { c, design } = await content('starter-staff-badge');
    expect(design.holder).toBe(true);
    expect(withKind(design, c.kind).holder).toBe(false);
    expect(resolvePaper({ schema: 1, size: 'cr80', barcode: 'qr', kind: 'badge' }).holder).toBe(
      false,
    );
    expect(
      resolvePaper({ schema: 1, size: 'cr80', barcode: 'qr', kind: 'badge', holder: true }).holder,
    ).toBe(true);
  });
});

describe('what each class prints', () => {
  it('a boarding pass shows from and to, flight, gate, times and seat', async () => {
    const { c } = await content('starter-boarding-pass');
    expect(c.title).toBe('SFO – JFK');
    expect(c.info).toMatchObject({
      from: 'SFO',
      fromCity: 'San Francisco',
      to: 'JFK',
      toCity: 'New York',
      vehicle: 'WA100',
      gate: 'B12',
      arrivesZone: 'America/New_York',
    });
    expect(c.info.boards).toBe('2030-06-01T07:15:00-07:00');
    expect(c.start).toBe('2030-06-01T08:00:00-07:00');
    expect(c.seat?.seat).toBe('14A');
    expect(c.zone).toBe('America/Los_Angeles');
  });

  it('a transit ticket shows the lane, party and board-by', async () => {
    const { c } = await content('starter-transit-ticket');
    expect(c.title).toBe('Newport → Harbor Point');
    expect(c.info).toMatchObject({
      gate: '4',
      gateLabel: 'Lane',
      party: 'Admits 3',
      boardsLabel: 'Board by',
    });
  });

  it('a booking leads with what, never with its time', async () => {
    const { c } = await content('starter-booking');
    expect(c.title).toBe('Cut and colour');
    expect(c.title).not.toMatch(/^\d{4}-/);
    expect(c.info).toMatchObject({ with: 'Sam', status: 'Booked' });
    expect(c.venue).toBe('Soho');
  });

  it('a stay shows check-in, check-out and nights', async () => {
    const { c } = await content('starter-hotel-stay');
    expect(c.start).toBe('2030-11-18T15:00:00-08:00');
    expect(c.end).toBe('2030-11-21T11:00:00-08:00');
    expect(c.info.nights).toBe('3');
    expect(c.info.included).toContain('Breakfast');
    // The Wi-Fi password is a credential of the room, not of the sheet.
    expect(JSON.stringify(c)).not.toContain('lamplight');
  });

  it('a visitor badge carries host, company, go to and arrival, with a photo', async () => {
    const { c } = await content('starter-visitor-pass');
    expect(c.photo).toBe(true);
    expect(c.info).toMatchObject({
      host: 'Priya Shah',
      company: 'Acme Ltd',
      goTo: 'Floor 3, Oslo',
    });
    expect(c.info.arrives).toBeDefined();
    expect(c.validUntil).toBeDefined();
  });

  it('a credential prints the number only when its lookup is public', async () => {
    const { c } = await content('starter-credential');
    expect(c.title).toBe('CPR / AED Provider');
    expect(c.info.issued).toBe('2026-03-15T00:00:00Z');
    expect(c.info.number).toBeUndefined();
  });

  it('a pack prints "pack of N", a stamp card its reward and goal, neither a live count', async () => {
    const pack = (await content('starter-pack')).c;
    expect(pack.hero?.offer).toBe('Pack of 10 washes');
    expect(JSON.stringify(pack)).not.toContain('"7"');
    const store = (await content('starter-store-card')).c;
    expect(JSON.stringify(store)).not.toMatch(/\$\s?\d/);
  });

  it("Henry's prints neither the member number nor ticket words", async () => {
    const { c, manifest } = await content('henrys-blue');
    const lookup = (manifest.scan as { lookup: { input: string } }).lookup.input;
    expect(lookup).toBe('memberId');
    expect(c.bring.join(' ')).not.toMatch(/page|ticket/i);
    expect(c.noun).not.toBe('ticket');
  });

  it('a timed ticket shows its party and a labelled entrance', async () => {
    const { c } = await content('starter-timed-ticket');
    expect(c.info.party).toBe('Admits 3');
    expect(c.room).toBe('Entrance B');
  });
});
