import { beforeAll, describe, expect, it } from 'vitest';
import { scanOf } from '../../shared/scan-defaults.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { SigningMaterial } from '../types.ts';
import { buildBaked, freezeNow, loadBaked } from './baked-fixtures.ts';

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

  it('a boarding pass with transitType still builds as air', async () => {
    const sample = await SAMPLE('starter-boarding-pass');
    const pass = (
      await buildBaked('starter-boarding-pass', material, { ...sample, transitType: 'train' })
    ).passJson;
    expect(pass.boardingPass?.transitType).toBe('PKTransitTypeAir');
  });
});
