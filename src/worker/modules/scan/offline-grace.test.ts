import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { TOUCH_EVERY_MS } from './auth-store.ts';
import { batch, batchOf, item, LIST, rosterOf, ticketTemplate } from './offline-test-fixtures.ts';
import { CONTACT_GAP_MS, CONTACT_GRACE_MS } from './repo-device.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const MIN = 60_000;
const rowsOf = (sql: string, params: (string | number)[] = []) =>
  all<Record<string, unknown>>(kit.env.DB, sql, params);
const stampOf = async (id: string) =>
  (
    await rowsOf(
      'SELECT contact_at AS at, contact_prev_at AS prev, online_since AS since FROM scanners WHERE id = ?',
      [id],
    )
  )[0];

/** A door with its list, last in contact at `t0`, then silent for `silence`; `reads` are dated just after t0. */
async function outage(silence: number, settings: Record<string, unknown> = LIST) {
  const tpl = await ticketTemplate();
  const scanner = await kit.scanner({ templateIds: [tpl], settings });
  const { headers } = scanner;
  const roster = await rosterOf(headers);
  const t0 = kit.clock.now();
  await run(
    kit.env.DB,
    'UPDATE scanners SET contact_at = ?, contact_prev_at = NULL, online_since = NULL WHERE id = ?',
    [t0, scanner.id],
  );
  kit.clock.advance(silence);
  const reads = async (n: number, from = 1) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = await kit.scanPass(tpl);
      out.push(item(p.scanCode ?? '', { clientTs: t0 + (from + i) * MIN, door: 'listed' }));
    }
    return out;
  };
  return { tpl, scanner, headers, roster, t0, reads };
}
const lateOf = async (reads: { idempotencyKey: string }[]) =>
  (
    await rowsOf(
      'SELECT COUNT(*) AS n FROM scan_offline_reads WHERE late = 1 AND idempotency_key IN (SELECT value FROM json_each(?))',
      [JSON.stringify(reads.map((r) => r.idempotencyKey))],
    )
  )[0]?.n;
const kinds = async (res: Response) => (await batchOf(res)).items.map((i) => i.outcome.kind);

describe('the reconnect grace', () => {
  it('keeps reads on time after GET /stats before the upload', async () => {
    const { headers, roster, reads } = await outage(60 * MIN);
    const queued = await reads(4);
    expect((await kit.get(headers, '/stats')).status).toBe(200);
    expect(await kinds(await batch(headers, queued, roster))).toEqual(Array(4).fill('ok'));
    expect(await lateOf(queued)).toBe(0);
  });

  it('keeps the second chunk on time after GET /stats between chunks', async () => {
    const { headers, roster, reads } = await outage(60 * MIN);
    const queued = await reads(4);
    await batch(headers, queued.slice(0, 2), roster);
    await kit.get(headers, '/stats');
    kit.clock.advance(2 * MIN);
    await kit.get(headers, '/stats');
    expect(await kinds(await batch(headers, queued.slice(2), roster))).toEqual(['ok', 'ok']);
    expect(await lateOf(queued)).toBe(0);
  });

  it('keeps reads on time for a door that signs in after a 20-minute outage', async () => {
    const tpl = await ticketTemplate();
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { ...LIST, staffSignIn: true },
    });
    const { headers } = scanner;
    const person = await kit.staff('door', 'Dana');
    const signIn = () => kit.post(headers, '/staff', { staffId: person.id, pin: person.pin });
    expect((await signIn()).status).toBe(200);
    const roster = await rosterOf(headers);
    const t0 = kit.clock.now();
    await run(kit.env.DB, 'UPDATE scanners SET contact_at = ? WHERE id = ?', [t0, scanner.id]);
    kit.clock.advance(20 * MIN);
    const queued = [];
    for (let i = 1; i <= 3; i++) {
      const p = await kit.scanPass(tpl);
      queued.push(item(p.scanCode ?? '', { clientTs: t0 + i * MIN, door: 'listed' }));
    }
    expect((await batch(headers, queued, roster)).status).toBe(403);
    expect((await signIn()).status).toBe(200);
    expect(await kinds(await batch(headers, queued, roster))).toEqual(['ok', 'ok', 'ok']);
    expect(await lateOf(queued)).toBe(0);
    expect((await stampOf(scanner.id))?.prev).toBe(t0);
  });

  it('keeps reads on time when a refused sync is retried after a poll', async () => {
    const { headers, roster, reads } = await outage(40 * MIN);
    const queued = await reads(3);
    expect((await kit.post(headers, '/batch', { items: 'not a list' })).status).toBe(422);
    await kit.get(headers, '/stats');
    await kit.post(headers, '/device', {});
    expect(await kinds(await batch(headers, queued, roster))).toEqual(['ok', 'ok', 'ok']);
    expect(await lateOf(queued)).toBe(0);
  });

  it('gives a dishonest door no earlier date than a silent one', async () => {
    const silent = await outage(60 * MIN);
    const back = await silent.reads(1, -30);
    const slack = await silent.reads(1, -3);
    await batch(silent.headers, [...back, ...slack], silent.roster);
    expect(await lateOf(back)).toBe(1);
    expect(await lateOf(slack)).toBe(0);
    const liar = await outage(60 * MIN);
    await kit.get(liar.headers, '/stats');
    const earlier = await liar.reads(1, -30);
    const same = await liar.reads(1, -3);
    await batch(liar.headers, [...earlier, ...same], liar.roster);
    expect(await lateOf(earlier)).toBe(1);
    expect(await lateOf(same)).toBe(0);
  });

  it('gives a door in steady contact no pre-contact dates', async () => {
    const { scanner, headers, roster, reads } = await outage(MIN);
    for (let i = 0; i < 6; i++) {
      await kit.get(headers, '/stats');
      kit.clock.advance(2 * MIN);
    }
    expect((await stampOf(scanner.id))?.prev).toBeNull();
    const old = await reads(1, 1);
    await batch(headers, old, roster);
    expect(await lateOf(old)).toBe(1);
  });

  it('starts the gap only after a real silence of CONTACT_GAP_MS, the stamp throttle included', async () => {
    const short = await outage(CONTACT_GAP_MS + TOUCH_EVERY_MS - 1);
    await kit.get(short.headers, '/stats');
    expect((await stampOf(short.scanner.id))?.prev).toBeNull();
    const exact = await outage(CONTACT_GAP_MS + TOUCH_EVERY_MS);
    await kit.get(exact.headers, '/stats');
    expect(await stampOf(exact.scanner.id)).toMatchObject({
      prev: exact.t0,
      since: kit.clock.now(),
    });
  });

  it('keeps the first outage dated when the link flaps inside the grace', async () => {
    const { scanner, headers, roster, t0, reads } = await outage(60 * MIN);
    await kit.get(headers, '/stats');
    const since = (await stampOf(scanner.id))?.since;
    const queued = await reads(2);
    // A second silence of 6 minutes inside the grace moves neither column.
    kit.clock.advance(6 * MIN);
    await kit.get(headers, '/stats');
    kit.clock.advance(6 * MIN);
    await kit.get(headers, '/stats');
    expect(await stampOf(scanner.id)).toMatchObject({ prev: t0, since });
    expect(await kinds(await batch(headers, queued, roster))).toEqual(['ok', 'ok']);
    expect(await lateOf(queued)).toBe(0);
  });

  it('judges a batch against the pre-gap contact for CONTACT_GRACE_MS after the reconnect, and not after', async () => {
    const { scanner, headers, roster, t0, reads } = await outage(60 * MIN);
    await kit.get(headers, '/stats');
    const reconnect = kit.clock.now();
    expect((await stampOf(scanner.id))?.prev).toBe(t0);
    while (kit.clock.now() - reconnect < CONTACT_GRACE_MS - 2 * MIN) {
      kit.clock.advance(MIN);
      await kit.get(headers, '/stats');
    }
    kit.clock.set(reconnect + CONTACT_GRACE_MS - 1);
    const inside = await reads(1, 10);
    await batch(headers, inside, roster);
    expect(kit.clock.now() - reconnect).toBe(CONTACT_GRACE_MS - 1);
    expect(await lateOf(inside)).toBe(0);
    kit.clock.advance(1);
    const outside = await reads(1, 11);
    await batch(headers, outside, roster);
    expect(await lateOf(outside)).toBe(1);
  });

  it('falls back to last_seen_at when contact_at is NULL (a row from before 0175)', async () => {
    const { scanner, headers, roster, t0, reads } = await outage(30 * MIN);
    await run(
      kit.env.DB,
      'UPDATE scanners SET contact_at = NULL, contact_prev_at = NULL, online_since = NULL, last_seen_at = ? WHERE id = ?',
      [t0, scanner.id],
    );
    const old = await reads(1, -30);
    const fine = await reads(1, 1);
    await batch(headers, [...old, ...fine], roster);
    expect(await lateOf(old)).toBe(1);
    expect(await lateOf(fine)).toBe(0);
    await run(kit.env.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [t0, scanner.id]);
    await kit.get(headers, '/stats');
    expect(await stampOf(scanner.id)).toMatchObject({ prev: t0 });
  });
});
