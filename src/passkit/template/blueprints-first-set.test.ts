import { beforeAll, describe, expect, it } from 'vitest';
import { scanOf } from '../../shared/scan-defaults.ts';
import { CONTRAST_MIN, contrastRatio } from '../index.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { PassJson, SigningMaterial } from '../types.ts';
import { buildBaked, freezeNow, loadBaked } from './baked-fixtures.ts';
import { defaultScanDisplay } from './scan-display/defaults.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
});

const SAMPLE = async (slug: string) =>
  (await loadBaked(slug, { strips: false })).template.manifest.sample;

describe('first blueprint set', () => {
  it('uses the scan code in every barcode but the ID card, which carries the real number', async () => {
    for (const slug of [
      'starter-pack',
      'starter-timed-ticket',
      'starter-transit-ticket',
      'starter-booking',
      'starter-pickup',
      'starter-permit',
      'starter-generic',
    ]) {
      const pass = (await buildBaked(slug, material)).passJson;
      expect(
        pass.barcodes?.map((b) => b.message),
        slug,
      ).toEqual(['SNAPSHOT-SCAN-CODE']);
    }
    const id = (await buildBaked('starter-id-card', material)).passJson;
    expect(id.barcodes?.map((b) => [b.format, b.message])).toEqual([
      ['PKBarcodeFormatCode39', '290014'],
      ['PKBarcodeFormatQR', '290014'],
    ]);
  });

  it('shows Appointment and drops the staff name on a discreet booking', async () => {
    const sample = await SAMPLE('starter-booking');
    const plain = (await buildBaked('starter-booking', material, sample)).passJson;
    expect(plain.generic?.secondaryFields?.map((f) => f.value)).toEqual(['Cut and colour', 'Sam']);
    const quiet = (await buildBaked('starter-booking', material, { ...sample, discreet: true }))
      .passJson;
    expect(quiet.generic?.secondaryFields?.map((f) => f.value)).toEqual(['Appointment']);
  });

  it('sets the transit type from the mode', async () => {
    const sample = await SAMPLE('starter-transit-ticket');
    const bus = (await buildBaked('starter-transit-ticket', material, { ...sample, mode: 'bus' }))
      .passJson;
    expect(bus.boardingPass?.transitType).toBe('PKTransitTypeBus');
    const boat = (await buildBaked('starter-transit-ticket', material, sample)).passJson;
    expect(boat.boardingPass?.transitType).toBe('PKTransitTypeBoat');
  });

  it('uses one of N: Use takes from what is left, Refill adds', async () => {
    const { template } = await loadBaked('starter-pack', { strips: false });
    const [use, refill] = scanOf(template.manifest).actions;
    expect(use).toMatchObject({
      kind: 'take',
      input: 'left',
      repeat: 'cooldown',
      cooldownMinutes: 5,
    });
    expect(refill).toMatchObject({ kind: 'add', input: 'left', minRole: 'desk', confirm: true });
  });

  it('Pack shows what is left from the counter and the pack size apart', async () => {
    const sample = await SAMPLE('starter-pack');
    const fields = (p: Awaited<ReturnType<typeof buildBaked>>['passJson']) =>
      [...(p.coupon?.headerFields ?? []), ...(p.coupon?.primaryFields ?? [])].map((f) => f.value);
    const build = async (over: Record<string, unknown>) =>
      fields((await buildBaked('starter-pack', material, { ...sample, ...over })).passJson);
    expect(await build({ left: 7, size: 10 })).toEqual([7, '10 washes']);
    // A refill raises left past size: never "15 of 10".
    expect(await build({ left: 15, size: 10 })).toEqual([15, '10 washes']);
    expect(await build({ left: 0, size: 10 })).toEqual([0, '10 washes']);
    expect((await build({ left: 5, size: 0 }))[1]).not.toContain(' of ');
  });

  it('Pack default scan display keeps the Pack row', async () => {
    const { template } = await loadBaked('starter-pack', { strips: false });
    const display = defaultScanDisplay(template.manifest, template.passJson as PassJson);
    expect(JSON.stringify(display)).toContain('"label":"Pack"');
  });

  it('flags a frozen or past-due Membership and takes guests from the count', async () => {
    const { template } = await loadBaked('starter-generic', { strips: false });
    const scan = template.manifest.scan;
    expect(scan?.flags?.[0]).toMatchObject({ input: 'status', stop: true });
    expect(scanOf(template.manifest).actions.map((a) => a.id)).toEqual(['check_in', 'guest_in']);
  });
});

describe('stored passes keep rebuilding', () => {
  it('a Membership with points still builds, and Cancelled voids it', async () => {
    const sample = await SAMPLE('starter-generic');
    const kept = (await buildBaked('starter-generic', material, { ...sample, points: 1200 }))
      .passJson;
    expect(kept.voided).toBe(false);
    const gone = (await buildBaked('starter-generic', material, { ...sample, status: 'Cancelled' }))
      .passJson;
    expect(gone.voided).toBe(true);
  });

  it('a boarding pass honours a stored transitType and defaults new ones to air', async () => {
    const sample = await SAMPLE('starter-boarding-pass');
    const train = (
      await buildBaked('starter-boarding-pass', material, { ...sample, transitType: 'train' })
    ).passJson;
    expect(train.boardingPass?.transitType).toBe('PKTransitTypeTrain');
    const fresh = (await buildBaked('starter-boarding-pass', material, sample)).passJson;
    expect(fresh.boardingPass?.transitType).toBe('PKTransitTypeAir');
  });

  it('a Membership with no guests or status builds: no free guests, active', async () => {
    const rest = { ...(await SAMPLE('starter-generic')) };
    for (const key of ['points', 'status', 'guests']) delete rest[key];
    const pass = (await buildBaked('starter-generic', material, rest)).passJson;
    expect(pass.voided).toBe(false);
    const fields = Object.values(pass.generic ?? {}).flat() as { key: string; value: unknown }[];
    expect(fields.find((f) => f.key === 'guests')?.value).toBe(0);
    expect(fields.find((f) => f.key === 'status')?.value).toBe('Active');
  });

  it.each([
    ['Standard', 'rgb(20,26,43)'],
    ['Plus', 'rgb(23,52,110)'],
    ['Pro', 'rgb(76,29,149)'],
  ])('a %s Membership takes its tier colours, readable', async (tier, bg) => {
    const sample = await SAMPLE('starter-generic');
    const { passJson: p } = await buildBaked('starter-generic', material, { ...sample, tier });
    expect(p.backgroundColor).toBe(bg);
    expect(contrastRatio(p.backgroundColor, p.foregroundColor)).toBeGreaterThanOrEqual(
      CONTRAST_MIN.text,
    );
    expect(contrastRatio(p.backgroundColor, p.labelColor)).toBeGreaterThanOrEqual(
      CONTRAST_MIN.label,
    );
  });

  it('a cancelled Booking voids and stops at the door', async () => {
    const sample = await SAMPLE('starter-booking');
    const pass = (await buildBaked('starter-booking', material, { ...sample, status: 'Cancelled' }))
      .passJson;
    expect(pass.voided).toBe(true);
    const { template } = await loadBaked('starter-booking', { strips: false });
    expect(template.manifest.scan?.flags).toContainEqual(
      expect.objectContaining({ label: 'Cancelled', stop: true }),
    );
  });

  it('shows the photo to the door on the ID card and Membership', async () => {
    for (const slug of ['starter-id-card', 'starter-generic'])
      expect(
        (await loadBaked(slug, { strips: false })).template.manifest.scan?.display?.photo,
      ).toEqual({ minRole: 'door' });
  });

  it('shows Admits on timed and transit tickets and keeps the event match keys as text inputs', async () => {
    for (const [slug, key] of [
      ['starter-timed-ticket', 'slotKey'],
      ['starter-transit-ticket', 'serviceKey'],
    ] as const) {
      const pass = (await buildBaked(slug, material)).passJson;
      const fields = Object.values(pass.eventTicket ?? pass.boardingPass ?? {}).flat() as {
        key: string;
        value: unknown;
      }[];
      expect(fields.find((f) => f.key === 'party')?.value, slug).toBe('Admits 3');
      const { template } = await loadBaked(slug, { strips: false });
      const props = template.manifest.inputs.properties as Record<string, { type?: string }>;
      expect(props[key]?.type).toBe('string');
    }
  });
});
