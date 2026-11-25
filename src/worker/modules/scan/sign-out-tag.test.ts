import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { personInside, station, trackedZone, useKit } from './occupancy/whos-in-test-fixtures.ts';
import { addType, clearTypes } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

const GUEST = () => ({
  tier: 'guest',
  endsAt: new Date(f.kit.clock.now() + 7_200_000).toISOString(),
});
let f: TagScanFixture;
let tpl: string;
let loaner: string;
beforeAll(async () => {
  f = await tagScanFixture();
  useKit(f.kit);
  tpl = await f.kit.scanTemplate('Visitor', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    tags: { uses: ['member', 'visitor'] },
    access: {
      input: { plan: 'tier', until: 'endsAt' },
      plans: [{ id: 'guest', label: 'Guest', kind: 'guest', zones: [{ zone: '*' }] }],
    },
  } as never);
  loaner = await addType(f, { use: 'visitor', scopes: 'pass' });
});
afterAll(() => clearTypes(f));

/** A guest inside a zone, holding a loaner, and a desk that checks the zone. */
async function lent(typeId = loaner) {
  const zone = await trackedZone();
  const pass = await personInside(tpl, 'Leo Park', [`zone:${zone.id}`], {
    at: f.kit.clock.now() - 3_600_000,
    input: GUEST(),
  });
  const desk = await station([tpl], [zone.id]);
  const tag = f.read();
  const res = await f.bind(desk.scanner, {
    card: { code: pass.scanCode ?? '', method: 'camera' },
    typeId,
    tag,
  });
  expect(res.status).toBe(200);
  const { bindingId } = (await res.json()) as { bindingId: string };
  return { zone, pass, desk, tag, bindingId };
}
const post = (desk: { headers: Record<string, string> }, body: Record<string, unknown>) =>
  f.kit.post(desk.headers, '/sign-out', { idempotencyKey: key(), ...body });
const binding = (id: string) =>
  first<{ end_cause: string | null; ended_by_type: string | null; ended_by: string | null }>(
    f.kit.env.DB,
    'SELECT end_cause, ended_by_type, ended_by FROM tag_bindings WHERE id = ?',
    [id],
  );
const lostOf = async (bindingId: string) =>
  first<{ lost_at: number | null; lost_by: string | null }>(
    f.kit.env.DB,
    'SELECT t.lost_at, t.lost_by FROM nfc_tags t JOIN tag_bindings b ON b.tag_id = t.id WHERE b.id = ?',
    [bindingId],
  );

describe('POST /scan/sign-out collects the lent tag', () => {
  it('returned: the binding ends at the desk and the tag is spare', async () => {
    const { pass, desk, bindingId } = await lent();
    const res = await post(desk, { passId: pass.id, tag: 'returned' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: pass.id, tag: 'returned' });
    expect(await binding(bindingId)).toEqual({
      end_cause: 'visitor_out',
      ended_by_type: 'scanner',
      ended_by: desk.scanner.id,
    });
    expect((await lostOf(bindingId))?.lost_at).toBeNull();
  });

  it('not returned: the tag is reported lost by the desk', async () => {
    const { pass, desk, bindingId } = await lent();
    const res = await post(desk, { passId: pass.id, tag: 'not_returned' });
    expect(await res.json()).toMatchObject({ tag: 'not_returned' });
    expect((await binding(bindingId))?.end_cause).toBe('lost');
    expect(await lostOf(bindingId)).toMatchObject({ lost_by: desk.scanner.id });
  });

  it('none: the tag stays lent', async () => {
    const { pass, desk, bindingId } = await lent();
    const res = await post(desk, { passId: pass.id });
    expect(await res.json()).toMatchObject({ tag: 'none' });
    expect((await binding(bindingId))?.end_cause).toBeNull();
  });

  it('a pass with no loaner answers none', async () => {
    const zone = await trackedZone();
    const pass = await personInside(tpl, 'Mia Stone', [`zone:${zone.id}`], { input: GUEST() });
    const desk = await station([tpl], [zone.id]);
    const res = await post(desk, { passId: pass.id, tag: 'returned' });
    expect(await res.json()).toMatchObject({ tag: 'none' });
  });

  it('a tap collects the tag and signs the person out', async () => {
    const { pass, desk, tag, bindingId, zone } = await lent();
    const res = await post(desk, { read: tag });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: pass.id, tag: 'returned' });
    expect((await binding(bindingId))?.end_cause).toBe('visitor_out');
    const row = await first<{ state: string }>(
      f.kit.env.DB,
      'SELECT state FROM scan_presence WHERE pass_id = ? AND scope = ?',
      [pass.id, `zone:${zone.id}`],
    );
    expect(row?.state).toBe('out');
  });

  it('a tap collects the tag of a person already out', async () => {
    const { desk, tag, bindingId, zone, pass } = await lent();
    expect((await post(desk, { passId: pass.id })).status).toBe(200);
    expect(zone.id).toBeTruthy();
    const res = await post(desk, { read: tag });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tag: 'returned' });
    expect((await binding(bindingId))?.end_cause).toBe('visitor_out');
  });

  it('a tag that is not lent is 409 TAG_NOT_LENT, an unknown tag is not found', async () => {
    const member = await addType(f, { use: 'member', scopes: 'pass' });
    const { desk, tag } = await lent(member);
    const res = await post(desk, { read: tag });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TAG_NOT_LENT' });
    expect((await post(desk, { read: f.read() })).status).toBe(404);
  });

  it('a repeat of the same request changes nothing and answers the same', async () => {
    const { pass, desk, bindingId } = await lent();
    const body = { idempotencyKey: key(), passId: pass.id, tag: 'not_returned' };
    const first1 = await f.kit.post(desk.headers, '/sign-out', body);
    const again = await f.kit.post(desk.headers, '/sign-out', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first1.json());
    expect((await binding(bindingId))?.end_cause).toBe('lost');
  });

  it('a request key used for another pass is refused', async () => {
    const a = await lent();
    const other = await personInside(tpl, 'Ana Kim', [`zone:${a.zone.id}`], { input: GUEST() });
    const body = { idempotencyKey: key(), tag: 'returned' };
    expect(
      (await f.kit.post(a.desk.headers, '/sign-out', { ...body, passId: a.pass.id })).status,
    ).toBe(200);
    const res = await f.kit.post(a.desk.headers, '/sign-out', { ...body, passId: other.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SCAN_KEY_REUSED' });
  });

  it('a door cannot collect, and a body must name the pass or the tag', async () => {
    const { pass, bindingId } = await lent();
    const door = await f.door();
    expect([401, 403]).toContain((await post(door, { passId: pass.id, tag: 'returned' })).status);
    expect((await binding(bindingId))?.end_cause).toBeNull();
    const desk = await f.desk();
    expect((await post(desk, {})).status).toBe(422);
    expect((await post(desk, { passId: pass.id, read: f.read() })).status).toBe(422);
  });
});
