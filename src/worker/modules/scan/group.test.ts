import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
    await act(door.headers, codeOf(a));
    const o = await out(
      await kit.post(door.headers, '/resolve', {
        input: codeOf(a),
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      }),
    );
    expect(o.bundle).toMatchObject({ name: 'Family', size: 2, checkedIn: 1 });
  });

  it('names each member by initials, the scanned pass first, and who is in', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl, { memberName: 'Ana Park' });
    const b = await kit.scanPass(tpl, { memberName: 'Ben Park' });
    const c = await kit.scanPass(tpl, { memberName: 'Cara Quinn' });
    await bundleOf([a, b, c]);
    await act(door.headers, codeOf(b));
    const o = await out(
      await kit.post(door.headers, '/resolve', {
        input: codeOf(b),
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      }),
    );
    expect(o.bundle?.members).toEqual([
      { initials: 'BP', checkedIn: true },
      { initials: 'AP', checkedIn: false },
      { initials: 'CQ', checkedIn: false },
    ]);
    // Initials only: never a full name on the wire.
    expect(JSON.stringify(o.bundle)).not.toMatch(/Ana Park|Cara Quinn/);
  });

  it('leaves the initials empty for a pass whose name this scanner may not read', async () => {
    const other = await kit.scanTemplate('VIP', { actions: [CHECK_IN] });
    const door = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl, { memberName: 'Ana Park' });
    const b = await kit.scanPass(other, { memberName: 'Secret Person' });
    await bundleOf([a, b]);
    await act(door.headers, codeOf(a));
    const o = await out(
      await kit.post(door.headers, '/resolve', {
        input: codeOf(a),
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      }),
    );
    expect(o.bundle?.members).toEqual([
      { initials: 'AP', checkedIn: true },
      { initials: '', checkedIn: false },
    ]);
    expect(JSON.stringify(o)).not.toContain('Secret');
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

  it('publishes every member to the live feed, and every member undo', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    await kit.scanner({ deviceRole: 'monitor' });
    const passes = [await kit.scanPass(tpl), await kit.scanPass(tpl), await kit.scanPass(tpl)] as [
      KitPass,
      KitPass,
      KitPass,
    ];
    await bundleOf(passes);
    const delivered: { kind?: string }[] = [];
    const original = kit.env.SCAN_HUB;
    Object.assign(kit.env, {
      SCAN_HUB: {
        getByName: () => ({
          publish: async (event: { kind?: string }) => {
            delivered.push(event);
            return true;
          },
        }),
      },
    });
    try {
      const o = await out(await group(door.headers, passes[0]));
      await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      const before = delivered.length;
      await undone(door.headers, o.scanId as string);
      await vi.waitFor(() => expect(delivered.length - before).toBeGreaterThanOrEqual(3), {
        timeout: 5000,
      });
    } finally {
      Object.assign(kit.env, { SCAN_HUB: original });
    }
  });

  const deskCheckIn = (name: string) =>
    kit.scanTemplate(name, {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'desk' }],
    });

  it('applies a manager PIN only to the members that need it, naming the manager on each scan', async () => {
    const desk = await deskCheckIn('Desk entry');
    const door = await kit.scanner({ templateIds: [tpl, desk] });
    const manager = await kit.staff('manager');
    const a = await kit.scanPass(tpl);
    const b = await kit.scanPass(desk);
    await bundleOf([a, b]);
    const o = await out(
      await act(door.headers, codeOf(a), {
        group: 'bundle',
        approval: { staffId: manager.id, pin: manager.pin },
      }),
    );
    expect(o.group).toMatchObject({ total: 2, done: 2, refused: 0 });
    const approvedBy = async (p: KitPass) =>
      (
        await first<{ approved_by: string | null }>(
          kit.env.DB,
          "SELECT approved_by FROM scans WHERE pass_id = ? AND outcome = 'ok'",
          [p.id],
        )
      )?.approved_by;
    expect(await approvedBy(a)).toBeNull();
    expect(await approvedBy(b)).toBe(manager.id);
  });

  it('refuses a member that needs approval when none is given', async () => {
    const desk = await deskCheckIn('Desk entry 2');
    const door = await kit.scanner({ templateIds: [tpl, desk] });
    const a = await kit.scanPass(tpl);
    const b = await kit.scanPass(desk);
    await bundleOf([a, b]);
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ total: 2, done: 1, refused: 1 });
    expect(o.group?.members?.[1]?.reason).toBe('needs_approval');
  });

  it('checks members in only, never the stamp the scanner defaults to', async () => {
    const stamps = await kit.scanTemplate('Stamp card', {
      actions: [{ id: 'add', label: 'Stamp', kind: 'add', amount: 1 }, CHECK_IN],
    });
    const door = await kit.scanner({ templateIds: [tpl, stamps] });
    const a = await kit.scanPass(tpl);
    const b = await kit.scanPass(stamps, { balance: 0 });
    await bundleOf([a, b]);
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ total: 2, done: 2 });
    const kinds = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) n FROM scans WHERE pass_id = ? AND action_kind != 'check_in'",
      [b.id],
    );
    expect(kinds?.n).toBe(0);
  });

  it('does not admit the scanned pass twice or a member already in again', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)] as [KitPass, KitPass];
    await bundleOf([a, b]);
    await act(door.headers, codeOf(a));
    await act(door.headers, codeOf(b));
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ total: 2, done: 0, already: 2 });
    expect(o.kind).toBe('heads_up');
    expect(await inCount([a, b])).toBe(2);
  });

  it('answers a refused scanned pass with its own refusal and admits no one', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)] as [KitPass, KitPass];
    await bundleOf([a, b]);
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [a.id]);
    const o = await out(await group(door.headers, a));
    expect(o.kind).toBe('refused');
    expect(o.reason).toBe('voided');
    expect(await inCount([a, b])).toBe(0);
  });

  it('always checks in, never out, at an in/out door', async () => {
    const door = await kit.scanner({ templateIds: [tpl] });
    await run(
      kit.env.DB,
      `UPDATE scanners SET settings = json_set(settings, '$.direction', 'both') WHERE id = ?`,
      [door.id],
    );
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)] as [KitPass, KitPass];
    await bundleOf([a, b]);
    await act(door.headers, codeOf(a));
    const o = await out(await group(door.headers, a));
    expect(o.group).toMatchObject({ done: 1, already: 1 });
    const outs = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) n FROM scans WHERE direction = 'out' AND pass_id IN (?, ?)",
      [a.id, b.id],
    );
    expect(outs?.n).toBe(0);
  });
});
