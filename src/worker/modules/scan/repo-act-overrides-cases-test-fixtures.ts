import { expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, MINUTE, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf, key, type ScanKit } from './test-kit.ts';

let manager: Awaited<ReturnType<ScanKit['staff']>> | undefined;
const ensureManager = async () => {
  manager ??= await kit.staff('manager', 'Boss');
  return manager;
};

export function registerOverrides() {
  async function doubled(letInAgain: 'anyone' | 'manager' | 'never') {
    await ensureManager();
    const s = await kit.scanner({ templateIds: [tpl], settings: { letInAgain } });
    const pass = await kit.scanPass(tpl);
    await act(s.headers, codeOf(pass));
    const heads = await out(await act(s.headers, codeOf(pass)));
    return { s, pass, heads };
  }

  it('anyone: Let in again records an override of the heads-up', async () => {
    const { s, pass, heads } = await doubled('anyone');
    expect(heads).toMatchObject({ reason: 'already_done', overridable: true });
    const o = await out(await act(s.headers, codeOf(pass), { overrideOf: heads.scanId }));
    expect(o.kind).toBe('ok');
    const row = await first<{ override_of: string }>(
      kit.env.DB,
      'SELECT override_of FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row?.override_of).toBe(heads.scanId);
    const again = await act(s.headers, codeOf(pass), { overrideOf: heads.scanId });
    expect(again.status).toBe(422);
  });

  it('manager: needs a Manager PIN, writes no row without it, records who approved', async () => {
    const { s, pass, heads } = await doubled('manager');
    const boss = await ensureManager();
    expect(heads.overridable).toBe(true);
    const idempotencyKey = key();
    const denied = await out(
      await act(s.headers, codeOf(pass), { overrideOf: heads.scanId, idempotencyKey }),
    );
    expect(denied).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
    const wrong = await act(s.headers, codeOf(pass), {
      overrideOf: heads.scanId,
      approval: { staffId: boss.id, pin: '000000' },
    });
    expect(wrong.status).toBe(400);
    const ok = await out(
      await act(s.headers, codeOf(pass), {
        overrideOf: heads.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(ok.kind).toBe('ok');
    const row = await first<{ approved_by: string }>(
      kit.env.DB,
      'SELECT approved_by FROM scans WHERE id = ?',
      [ok.scanId ?? ''],
    );
    expect(row?.approved_by).toBe(boss.id);
  });

  it('manager: a Desk person is not an approver', async () => {
    const { s, pass, heads } = await doubled('manager');
    const clerk = await kit.staff('desk');
    const res = await act(s.headers, codeOf(pass), {
      overrideOf: heads.scanId,
      approval: { staffId: clerk.id, pin: clerk.pin },
    });
    expect(res.status).toBe(400);
  });

  it('never: nobody can let the pass in again, and the heads-up is not overridable', async () => {
    const { s, pass, heads } = await doubled('never');
    expect(heads.overridable).toBe(false);
    const boss = await ensureManager();
    const o = await out(
      await act(s.headers, codeOf(pass), {
        overrideOf: heads.scanId,
        approval: { staffId: boss.id, pin: boss.pin },
      }),
    );
    expect(o).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
  });

  it("rejects an override of another scanner's scan, another pass, an ok row, or an 11-minute-old heads-up", async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const b = await kit.scanner({ templateIds: [tpl] });
    const [p, q] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const okA = await out(await act(a.headers, codeOf(p)));
    const headsA = await out(await act(a.headers, codeOf(p)));
    const code = async (res: Response) => ((await res.json()) as { code: string }).code;
    const bad = async (
      headers: Record<string, string>,
      pass: typeof p,
      overrideOf: string | null,
    ) => {
      const res = await act(headers, codeOf(pass), { overrideOf });
      return { status: res.status, code: await code(res) };
    };
    expect(await bad(b.headers, p, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, q, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, p, okA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    expect(await bad(a.headers, p, 'no-such-scan')).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
    kit.clock.advance(11 * MINUTE);
    expect(await bad(a.headers, p, headsA.scanId)).toEqual({
      status: 422,
      code: 'SCAN_OVERRIDE_INVALID',
    });
  });

  it('capacity: the next pass past Full is a heads-up, and an override lets it in', async () => {
    const t = await kit.scanTemplate('Small room', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity = 1 WHERE id = ?', [ev.id]);
    // Managers seeded by earlier cases of the shared org would make the override approvable.
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at = 1 WHERE org_id = ?', [kit.org.id]);
    const s = await kit.scanner({ eventId: ev.id });
    const [p, q] = [await kit.scanPass(t), await kit.scanPass(t)];
    expect((await out(await act(s.headers, codeOf(p)))).kind).toBe('ok');
    // `letInAgain: anyone` is not enough: a full event is only ever let in by a manager, so a
    // scanner with no manager to approve cannot override it.
    const full = await out(await act(s.headers, codeOf(q)));
    expect(full).toMatchObject({ kind: 'heads_up', reason: 'capacity_full', overridable: false });
    const refused = await act(s.headers, codeOf(q), { overrideOf: full.scanId });
    expect(refused.status === 200 ? (await out(refused)).kind : refused.status).not.toBe('ok');
    // An administrator is a manager.
    const scope = { orgId: kit.org.id, eventId: ev.id, timeZone: 'UTC' };
    const admin = kit.admin();
    const full2 = await out(await act(admin, codeOf(q), { scope, actionId: 'check_in' }));
    expect(full2).toMatchObject({ kind: 'heads_up', reason: 'capacity_full', overridable: true });
    const ok = await out(
      await act(admin, codeOf(q), { overrideOf: full2.scanId, scope, actionId: 'check_in' }),
    );
    expect(ok.kind).toBe('ok');
    expect(ok.counts.event).toMatchObject({ arrived: 2, capacity: 1 });
  });

  it.each([
    { state: 'quarantined', mode: 'test' as const, set: 'test_data_quarantined=1' },
    { state: 'deleted', mode: 'live' as const, set: 'deleted_at=1' },
  ])('does not count a $state pass’s legacy gate against capacity', async ({ mode, set }) => {
    const t = await kit.scanTemplate('Legacy capacity', { actions: [CHECK_IN] });
    const event = await kit.event({ mode, templateIds: [t] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({ mode, eventId: event.id });
    const occupant = await kit.scanPass(t, {}, { mode });
    const next = await kit.scanPass(t, {}, { mode });
    const extra = await kit.scanPass(t, {}, { mode });
    expect((await out(await act(scanner.headers, codeOf(occupant)))).kind).toBe('ok');
    await run(kit.env.DB, `UPDATE passes SET ${set} WHERE id=?`, [occupant.id]);
    expect(
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM scan_gates WHERE pass_id=?',
        [occupant.id],
      ),
    ).toEqual({ n: 1 });

    const admitted = await out(await act(scanner.headers, codeOf(next)));
    expect(admitted.kind).toBe('ok');
    // Arrivals keep the historical entry; only the live pass occupies capacity.
    expect(admitted.counts.event).toMatchObject({
      arrived: set === 'deleted_at=1' ? 2 : 1,
      capacity: 1,
    });
    expect(await out(await act(scanner.headers, codeOf(extra)))).toMatchObject({
      kind: 'heads_up',
      reason: 'capacity_full',
    });
  });

  it('the pass window: a heads-up not_yet_valid can be let through', async () => {
    const t = await kit.scanTemplate('Timed', {
      actions: [CHECK_IN],
      window: { from: 'startsAt' },
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t, {
      startsAt: new Date(kit.clock.now() + HOUR).toISOString(),
    });
    const early = await out(await act(s.headers, codeOf(pass)));
    expect(early).toMatchObject({ reason: 'not_yet_valid', overridable: true });
    expect((await out(await act(s.headers, codeOf(pass), { overrideOf: early.scanId }))).kind).toBe(
      'ok',
    );
  });

  it('a stop flag holds the check-in until confirmed', async () => {
    const t = await kit.scanTemplate('Flagged', {
      actions: [CHECK_IN],
      flags: [{ input: 'tier', label: 'Unpaid dues', equals: ['overdue'], stop: true }],
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t, { tier: 'overdue' });
    expect(await out(await act(s.headers, codeOf(pass)))).toMatchObject({
      reason: 'check_required',
      flags: ['Unpaid dues'],
    });
    const ok = await out(await act(s.headers, codeOf(pass), { confirmed: true }));
    expect(ok).toMatchObject({ kind: 'ok', flags: ['Unpaid dues'] });
  });

  it('only returns flag labels whose inputs are visible to the scanner role', async () => {
    const t = await kit.scanTemplate('Private flags', {
      actions: [CHECK_IN],
      flags: [
        { input: 'tier', label: 'Needs review', equals: ['overdue'] },
        { input: 'balance', label: 'Financial alert', equals: ['23'] },
        { input: 'memberNo', label: 'Welcome', equals: ['club'] },
      ],
    });
    const base = await kit.registry.resolve(t);
    const template = kit.registry.add({
      id: t,
      orgId: kit.org.id,
      version: 'v2',
      manifest: {
        ...base.manifest,
        inputs: {
          ...base.manifest.inputs,
          properties: {
            ...base.manifest.inputs.properties,
            tier: { type: 'string', 'x-scan': 'manager' },
            balance: { type: 'integer', 'x-scan': 'hidden' },
          },
        },
      },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    await approveAppleRelease(kit, { templateId: t, mode: 'live', version: template.version });
    const door = await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'door' } });
    const managerStaff = await kit.staff('manager');
    const manager = await kit.scanner({
      templateIds: [t],
      staffId: managerStaff.id,
      settings: { staffSignIn: true },
    });
    const input = { tier: 'overdue', balance: 23, memberNo: 'club' };
    const doorPass = await kit.scanPass(t, input);
    const managerPass = await kit.scanPass(t, input);
    expect(await out(await act(door.headers, codeOf(doorPass)))).toMatchObject({
      kind: 'ok',
      flags: ['Welcome'],
    });
    expect(await out(await act(manager.headers, codeOf(managerPass)))).toMatchObject({
      kind: 'ok',
      flags: ['Needs review', 'Welcome'],
    });
  });
}
