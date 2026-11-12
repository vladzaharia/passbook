import { expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { act, kit, MINUTE, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

export function registerCheckIn() {
  it('lets a pass in once and answers with the count, the display and an undo time', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const res = await act(s.headers, codeOf(pass));
    const o = await out(res);
    expect(res.status).toBe(200);
    expect(o).toMatchObject({
      kind: 'ok',
      reason: null,
      replay: false,
      action: { id: 'check_in' },
      milestone: null,
    });
    expect(o.scanId).toEqual(expect.any(String));
    expect(o.counts.today).toBe(1);
    expect(o.undoUntil).toBe(kit.clock.now() + 10 * MINUTE);
    expect(o.display?.identity.holder).toBe('Anna Popescu');
    const row = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(row).toMatchObject({
      state: 'done',
      outcome: 'ok',
      pass_id: pass.id,
      action_kind: 'check_in',
      pass_version: pass.version,
    });
  });

  it('creates no pass version and no pass.updated event', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const versions = () =>
      first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ?',
        [pass.id],
      );
    const before = await versions();
    await act(s.headers, codeOf(pass));
    expect(await versions()).toEqual(before);
    const events = await rows<{ kind: string }>(
      'SELECT kind FROM pass_events WHERE pass_id = ? ORDER BY at',
      [pass.id],
    );
    expect(events.map((e) => e.kind).filter((k) => k.startsWith('scan.'))).toEqual([
      'scan.checked_in',
    ]);
    expect(events.map((e) => e.kind)).not.toContain('pass.updated');
    expect(
      (
        await first<{ version: number }>(kit.env.DB, 'SELECT version FROM passes WHERE id = ?', [
          pass.id,
        ])
      )?.version,
    ).toBe(pass.version);
  });

  it('the second scan is already_done and names the first scanner and time', async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const b = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const first = await out(await act(a.headers, codeOf(pass)));
    kit.clock.advance(5 * MINUTE);
    const second = await out(await act(b.headers, codeOf(pass)));
    expect(second).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    expect(second.previous).toMatchObject({
      scanId: first.scanId,
      scannerName: expect.stringContaining('Scanner'),
      override: false,
    });
    expect(second.previous?.at).toBe(kit.clock.now() - 5 * MINUTE);
  });
}
