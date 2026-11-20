import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { act, CHECK_IN, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

type KitPass = Awaited<ReturnType<typeof kit.scanPass>>;

async function bundleOf(passes: KitPass[], orgId = kit.org.id, mode = 'live') {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO bundles (id, org_id, mode, name, token, created_at) VALUES (?, ?, ?, 'Family', ?, ?)`,
    [id, orgId, mode, `h1:${kit.fx.ids.token()}`, kit.clock.now()],
  );
  for (const [i, p] of passes.entries())
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, ?)',
      [id, p.id, i],
    );
  return id;
}

const group = (headers: Record<string, string>, pass: KitPass, idem = key()) =>
  act(headers, codeOf(pass), { group: 'bundle', idempotencyKey: idem });
const undone = (headers: Record<string, string>, scanId: string, idem = key()) =>
  kit.post(headers, `/scans/${scanId}/undo`, { idempotencyKey: idem });
const inCount = async (passes: KitPass[]) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      `SELECT COUNT(*) n FROM scans WHERE pass_id IN (${passes.map(() => '?').join(',')})
         AND outcome = 'ok' AND action_kind = 'check_in' AND undone_by IS NULL`,
      passes.map((p) => p.id),
    )
  )?.n;

describe('bundle check-in', () => {
  it('offers the chip on a scan of one member', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl);
    const b = await kit.scanPass(tpl);
    await bundleOf([a, b]);
    const o = await out(await act(door.headers, codeOf(a)));
    expect(o.bundle).toMatchObject({ name: 'Family', size: 2, checkedIn: 1 });
  });

  it('checks in every member across two pass types, one verdict each', async () => {
    const other = await kit.scanTemplate('Kids card', { actions: [CHECK_IN] });
    const door = await kit.scanner({ templateIds: [tpl, other] });
    const passes = [await kit.scanPass(tpl), await kit.scanPass(other), await kit.scanPass(tpl)];
    await bundleOf(passes);
    const o = await out(await group(door.headers, passes[0] as KitPass));
    expect(o.kind).toBe('ok');
    expect(o.group).toMatchObject({ total: 3, done: 3, already: 0, refused: 0 });
    expect(o.group?.members?.map((m) => m.state)).toEqual(['done', 'done', 'done']);
    expect(await inCount(passes)).toBe(3);
  });

  it('shows a refused member and an already-in member without hiding the rest', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const [a, b, c] = [
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
    ] as [KitPass, KitPass, KitPass];
    await bundleOf([a, b, c]);
    await act(door.headers, codeOf(b));
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [c.id]);
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ total: 3, done: 1, already: 1, refused: 1 });
    expect(o.group?.members?.map((m) => [m.state, m.reason])).toEqual([
      ['done', null],
      ['already', 'already_done'],
      ['refused', 'voided'],
    ]);
  });

  it('refuses a member whose type the scanner does not accept', async () => {
    const other = await kit.scanTemplate('VIP', { actions: [CHECK_IN] });
    const door = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl);
    const b = await kit.scanPass(other);
    await bundleOf([a, b]);
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ total: 2, done: 1, refused: 1 });
    expect(o.group?.members?.[1]?.reason).toBe('not_accepted');
  });

  it('is idempotent on a replayed key', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const passes = [await kit.scanPass(tpl), await kit.scanPass(tpl)] as [KitPass, KitPass];
    await bundleOf(passes);
    const idem = key();
    const first1 = await out(await group(door.headers, passes[0], idem));
    const again = await out(await group(door.headers, passes[0], idem));
    expect(again.group).toMatchObject({ total: 2, done: 2 });
    expect(again.scanId).toBe(first1.scanId);
    expect(await inCount(passes)).toBe(2);
  });

  it('undoes the whole group with one request, and replays it', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const passes = [await kit.scanPass(tpl), await kit.scanPass(tpl), await kit.scanPass(tpl)] as [
      KitPass,
      KitPass,
      KitPass,
    ];
    await bundleOf(passes);
    const o = await out(await group(door.headers, passes[0]));
    expect(await inCount(passes)).toBe(3);
    const idem = key();
    const res = await undone(door.headers, o.scanId as string, idem);
    expect(res.status).toBe(200);
    expect(await inCount(passes)).toBe(0);
    expect((await undone(door.headers, o.scanId as string, idem)).status).toBe(200);
  });

  it('never reaches a bundle of another org', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl);
    const org2 = await makeOrg(kit.fx, { name: 'Other' });
    await bundleOf([a], org2.id);
    const o = await out(await group(door.headers, a));
    expect(o.group).toBeNull();
    expect(o.bundle).toBeFalsy();
  });
});
