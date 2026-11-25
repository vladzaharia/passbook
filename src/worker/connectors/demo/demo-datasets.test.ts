import { describe, expect, it } from 'vitest';
import { DEMO_LOCALES } from '../../../generated/demo-words.ts';
import { DATASETS } from './config.ts';
import { DATASET_DEFS, refOf } from './datasets/index.ts';
import { luhnCard } from './datasets/loyalty-cards.ts';
import connector from './index.ts';
import { demoCtx, listRecords, ms, str } from './test-kit.ts';

const V2 = DATASETS.filter((d) => d !== 'classic');
const GOLDEN = { seed: 'golden', anchor: '2026-03-02', count: 3 };

describe('demo v2 goldens', () => {
  it.each(V2)('%s: first three en-US records and one per other locale', async (dataset) => {
    const rows: Record<string, unknown> = {};
    for (const locale of DEMO_LOCALES) {
      const count = locale === 'en-US' ? 3 : 1;
      rows[locale] = await listRecords({ ...GOLDEN, dataset, locale, count });
    }
    await expect(`${JSON.stringify(rows, null, 1)}\n`).toMatchFileSnapshot(
      `./__golden__/${dataset}.json`,
    );
  });
});

describe('demo v2 shape', () => {
  it.each(V2)('%s: refs, locale and determinism', async (dataset) => {
    const a = await listRecords({ dataset, count: 60, seed: 'x' });
    const b = await listRecords({ dataset, count: 60, seed: 'x' });
    const other = await listRecords({ dataset, count: 60, seed: 'y' });
    expect(a).toHaveLength(60);
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
  });

  it.each(V2)('%s: fetchRecord does not depend on count', async (dataset) => {
    const small = demoCtx({ dataset, count: 5 });
    const big = demoCtx({ dataset, count: 400 });
    const first = (await listRecords({ dataset, count: 1 }))[0];
    const ref = refOf(DATASET_DEFS[dataset as keyof typeof DATASET_DEFS], 1);
    const a = await connector.fetchRecord(small, ref);
    const b = await connector.fetchRecord(big, ref);
    expect(a).toEqual(b);
    expect(a.status === 'ok' && a.record).toEqual(first);
    expect(await connector.fetchRecord(small, 'z-0001')).toEqual({ status: 'not_found' });
  });

  it.each(V2)('%s: no URLs, reserved email domains, no real inbox', async (dataset) => {
    const rows = await listRecords({ dataset, count: 150, locale: 'fr-FR' });
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toMatch(/https?:|www\.|\.(com|net|org)\//i);
      expect(str(r, 'email')).toMatch(/@example\.com$/);
    }
    const emails = rows.map((r) => str(r, 'email'));
    if (dataset !== 'event-tickets') expect(new Set(emails).size).toBe(emails.length);
  });

  it('refuses a real holder domain on v2 datasets but keeps it on classic', () => {
    expect(() => demoCtx({ dataset: 'gym-members', holderDomain: 'gmail.com' })).toThrow();
    for (const ok of ['example.org', 'mail.example.net', 'corp.test', 'x.invalid', 'a.example']) {
      expect(() => demoCtx({ dataset: 'bookings', holderDomain: ok })).not.toThrow();
    }
    expect(demoCtx({ holderDomain: 'acme.io' }).connection.config.holderDomain).toBe('acme.io');
  });

  it('stamps the anchor at create, once, and never for classic', () => {
    const prepare = connector.prepareConfig;
    const now = Date.parse('2026-07-09T12:00:00Z');
    const v2 = demoCtx({ dataset: 'gym-members' }).connection.config;
    expect(prepare?.(v2, { now })?.anchor).toBe('2026-07-09');
    const set = demoCtx({ dataset: 'gym-members', anchor: '2026-01-01' }).connection.config;
    expect(prepare?.(set, { now })?.anchor).toBe('2026-01-01');
    const classic = demoCtx({}).connection.config;
    expect(prepare?.(classic, { now })).toBe(classic);
  });
});

describe('demo v2 invariants', () => {
  it('event-tickets: unique seats per event, one buyer per order', async () => {
    const rows = await listRecords({ dataset: 'event-tickets', count: 1000 });
    const seats = new Set<string>();
    const orders = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = `${str(r, 'eventName')}|${str(r, 'venueRoom')}|${str(r, 'seat')}`;
      expect(seats.has(key)).toBe(false);
      seats.add(key);
      const buyers = orders.get(str(r, 'orderRef')) ?? new Set();
      buyers.add(str(r, 'email'));
      orders.set(str(r, 'orderRef'), buyers);
    }
    expect([...orders.values()].every((b) => b.size === 1)).toBe(true);
    const sizes = new Map<string, number>();
    for (const r of rows) sizes.set(str(r, 'orderRef'), (sizes.get(str(r, 'orderRef')) ?? 0) + 1);
    expect(Math.max(...sizes.values())).toBeLessThanOrEqual(4);
    expect(Math.max(...sizes.values())).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => str(r, 'eventName'))).size).toBeGreaterThanOrEqual(3);
  });

  it('boarding-passes: boards before departing before arriving; seats unique per flight', async () => {
    const rows = await listRecords({ dataset: 'boarding-passes', count: 1000 });
    const seats = new Set<string>();
    for (const r of rows) {
      expect(ms(r, 'boardsAt')).toBeLessThan(ms(r, 'departsAt'));
      expect(ms(r, 'departsAt')).toBeLessThan(ms(r, 'arrivesAt'));
      expect(ms(r, 'departsAt') - ms(r, 'boardsAt')).toBe(40 * 60_000);
      expect(str(r, 'origin')).not.toBe(str(r, 'destination'));
      const key = `${str(r, 'airlineCode')}${str(r, 'flightNumber')}|${str(r, 'departsAt')}|${str(r, 'seat')}`;
      expect(seats.has(key)).toBe(false);
      seats.add(key);
    }
    const flights = new Set(rows.map((r) => `${str(r, 'airlineCode')}${str(r, 'flightNumber')}`));
    expect(flights.size).toBeGreaterThanOrEqual(4);
    expect(flights.size).toBeLessThanOrEqual(8);
  });

  it('hotel-stays: checkOut is checkIn plus nights; no room is double-booked', async () => {
    const rows = await listRecords({
      dataset: 'hotel-stays',
      count: 1000,
      changeRate: 100,
      revision: 3,
    });
    const byRoom = new Map<string, [number, number][]>();
    for (const r of rows) {
      const inDay = Date.parse(`${str(r, 'checkIn').slice(0, 10)}T00:00:00Z`);
      const outDay = Date.parse(`${str(r, 'checkOut').slice(0, 10)}T00:00:00Z`);
      expect(outDay - inDay).toBe(Number(r.nights) * 86_400_000);
      expect(str(r, 'checkIn')).toMatch(/T15:00:00/);
      expect(str(r, 'checkOut')).toMatch(/T11:00:00/);
      const list = byRoom.get(str(r, 'room')) ?? [];
      list.push([ms(r, 'checkIn'), ms(r, 'checkOut')]);
      byRoom.set(str(r, 'room'), list);
    }
    for (const list of byRoom.values()) {
      list.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < list.length; i++) {
        expect((list[i] as number[])[0]).toBeGreaterThanOrEqual(
          (list[i - 1] as number[])[1] as number,
        );
      }
    }
  });

  it('bookings: business hours, nobody double-booked, even after moves', async () => {
    const rows = await listRecords({
      dataset: 'bookings',
      count: 1000,
      changeRate: 100,
      revision: 2,
    });
    const byStaff = new Map<string, [number, number][]>();
    for (const r of rows) {
      const start = new Date(str(r, 'startsAt').slice(0, 19));
      expect(start.getDay()).toBeGreaterThanOrEqual(1);
      expect(start.getDay()).toBeLessThanOrEqual(5);
      expect(start.getHours()).toBeGreaterThanOrEqual(9);
      expect(start.getHours() * 60 + start.getMinutes() + 30).toBeLessThanOrEqual(17 * 60);
      const list = byStaff.get(str(r, 'with')) ?? [];
      list.push([ms(r, 'startsAt'), ms(r, 'endsAt')]);
      byStaff.set(str(r, 'with'), list);
    }
    expect(byStaff.size).toBe(6);
    for (const list of byStaff.values()) {
      list.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < list.length; i++) {
        expect((list[i] as number[])[0]).toBeGreaterThanOrEqual(
          (list[i - 1] as number[])[1] as number,
        );
      }
    }
    expect(new Set(rows.map((r) => str(r, 'status'))).size).toBeGreaterThan(1);
  });

  it('loyalty-cards: 16-digit Luhn-valid numbers', async () => {
    const rows = await listRecords({
      dataset: 'loyalty-cards',
      count: 500,
      changeRate: 100,
      revision: 2,
    });
    for (const r of rows) {
      const n = str(r, 'cardNumber');
      expect(n).toMatch(/^\d{16}$/);
      expect(luhnCard(n.slice(0, 15))).toBe(n);
      expect(Number(r.stamps)).toBeLessThanOrEqual(9);
    }
    expect(luhnCard('7992739871')).toBe('79927398713');
  });

  it('transit-tickets: admits is adults plus children', async () => {
    for (const r of await listRecords({ dataset: 'transit-tickets', count: 300 })) {
      expect(Number(r.admits)).toBe(Number(r.adults) + Number(r.children));
      expect(ms(r, 'boardBy')).toBeLessThan(ms(r, 'departsAt'));
    }
  });

  it('staff-badges and gym-members: contractors are short, validity follows the plan', async () => {
    const staff = await listRecords({ dataset: 'staff-badges', count: 300 });
    expect(new Set(staff.map((r) => str(r, 'company'))).size).toBe(1);
    for (const r of staff.filter((x) => x.plan === 'contractor')) {
      expect(ms(r, 'validUntil') - ms(r, 'validFrom')).toBeLessThanOrEqual(14 * 86_400_000);
    }
    for (const r of await listRecords({ dataset: 'gym-members', count: 200 })) {
      const days = (ms(r, 'validUntil') - ms(r, 'validFrom')) / 86_400_000;
      expect(days).toBe(r.plan === 'guest' ? 7 : 30);
    }
  });

  it('dates follow the anchor, not today', async () => {
    const a = await listRecords({ dataset: 'event-tickets', count: 20, anchor: '2030-06-01' });
    for (const r of a) expect(str(r, 'startsAt').slice(0, 4)).toBe('2030');
  });
});

describe('demo v2 failure modes', () => {
  it('lists 50 per page', async () => {
    const page = await connector.listChanges?.(demoCtx({ dataset: 'bookings', count: 120 }), null);
    expect(page?.changes).toHaveLength(50);
    expect(page?.hasMore).toBe(true);
  });

  it('forbidden is a 403 and page_two fails only the second page', async () => {
    await expect(
      connector.fetchRecord(demoCtx({ fail: 'forbidden' }), 'm-001'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
    const ctx = demoCtx({ dataset: 'gym-members', count: 120, fail: 'page_two' });
    const first = await connector.listChanges?.(ctx, null);
    expect(first?.changes).toHaveLength(50);
    await expect(connector.listChanges?.(ctx, first?.cursor ?? null)).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
    await expect(connector.test?.(ctx)).resolves.toMatchObject({ ok: true });
  });

  it('bad_records empties the key fields of one record in 20', async () => {
    const rows = await listRecords({ dataset: 'gym-members', count: 100, fail: 'bad_records' });
    const bad = rows.filter((r) => r.memberName === '');
    expect(bad).toHaveLength(5);
    expect(rows.filter((r) => r.memberName !== '')).toHaveLength(95);
  });

  it('reports missing refs as deleted', async () => {
    const rows = await connector.listChanges?.(
      demoCtx({ dataset: 'bookings', count: 5, missing: ['b-0002'] }),
      null,
    );
    expect(rows?.changes.find((c) => c.ref === 'b-0002')).toEqual({ ref: 'b-0002', deleted: true });
  });
});
