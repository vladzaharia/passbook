import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { act, CHECK_IN, HOUR, kit, MINUTE, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerGates() {
  it('daily resets at the venue midnight, in each time zone', async () => {
    const t = await kit.scanTemplate('Daily', { actions: [{ ...CHECK_IN, repeat: 'daily' }] });
    const utc = await kit.scanner({ templateIds: [t] });
    const nz = await kit.scanner({ templateIds: [t] });
    await run(kit.env.DB, "UPDATE scanners SET time_zone = 'Pacific/Auckland' WHERE id = ?", [
      nz.id,
    ]);
    const [p, q] = [await kit.scanPass(t), await kit.scanPass(t)];
    kit.clock.set((Math.floor(kit.clock.now() / (24 * HOUR)) + 1) * 24 * HOUR - 90 * MINUTE);
    expect((await out(await act(utc.headers, codeOf(p)))).kind).toBe('ok');
    expect((await out(await act(nz.headers, codeOf(q)))).kind).toBe('ok');
    kit.clock.advance(2 * HOUR);
    expect((await out(await act(utc.headers, codeOf(p)))).kind).toBe('ok');
    expect((await out(await act(nz.headers, codeOf(q)))).reason).toBe('already_done');
  });

  it('a cooldown action says how long is left', async () => {
    const t = await kit.scanTemplate('Cool', {
      actions: [{ ...CHECK_IN, repeat: 'cooldown', cooldownMinutes: 10 }],
    });
    const s = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t);
    await act(s.headers, codeOf(pass));
    kit.clock.advance(4 * MINUTE);
    const second = await out(await act(s.headers, codeOf(pass)));
    expect(second).toMatchObject({ reason: 'cooldown', cooldownRemainingMs: 6 * MINUTE });
    kit.clock.advance(7 * MINUTE);
    expect((await out(await act(s.headers, codeOf(pass)))).kind).toBe('ok');
  });

  it('an unknown action id is 422 SCAN_ACTION_UNKNOWN and leaves no row', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const res = await act(s.headers, codeOf(pass), { actionId: 'nope', idempotencyKey });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_ACTION_UNKNOWN');
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
  });

  it('on a desk scanner (flow choose) auto answers ready and writes nothing', async () => {
    const s = await kit.scanner({ templateIds: [tpl], settings: { flow: 'choose' } });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const o = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    expect(o).toMatchObject({ kind: 'ready', reason: 'choose' });
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(0);
  });

  it('refusals are recorded: a row, and a ledger event for a known pass', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    const o = await out(await act(s.headers, codeOf(pass)));
    expect(o).toMatchObject({ kind: 'refused', reason: 'voided' });
    const row = await first<{ outcome: string; reason: string }>(
      kit.env.DB,
      'SELECT outcome, reason FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row).toEqual({ outcome: 'refused', reason: 'voided' });
    const events = await rows<{ kind: string }>(
      "SELECT kind FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(events).toEqual([{ kind: 'scan.rejected' }]);
  });
}
