import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { cronWithInterleave, stage } from './act-recovery-test-fixtures.ts';
import { act, expectUnavailable, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { reconcileScans } from './jobs.ts';
import { markScanEffectIntentStmt, scanByKey } from './repo-scans.ts';
import { key } from './test-kit.ts';

export function registerRecovery() {
  it('a request still pending under 15 s is 409 SCAN_IN_PROGRESS with Retry-After 1', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const res = await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey });
    expect(res.status).toBe(409);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_IN_PROGRESS');
  });

  it('never retries a pre-effect intent even before recovery observes a gate', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(scanner, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${scanner.id}`, req.idempotencyKey);
    expect(claimed).not.toBeNull();
    if (!claimed) throw new Error('Missing pending claim');
    expect(
      (await markScanEffectIntentStmt(kit.env.DB, claimed.id, claimed.at).all()).results,
    ).toHaveLength(1);
    expectUnavailable(
      await out(await act(scanner.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    // A retry past the in-progress window leaves the row alone now; the cron (60s) fails it.
    kit.clock.advance(61_000);
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expectUnavailable(
      await out(await act(scanner.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [claimed.id]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
    expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id = ?', [pass.id])).toHaveLength(
      0,
    );
  });

  it('preserves observed presence ambiguity when it disappears before recovery finalizes', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(scanner, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${scanner.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing pending claim');
    await run(
      kit.env.DB,
      `INSERT INTO scan_presence
      (pass_id,org_id,scope,state,tracking,entered_at,first_at,last_entry_at,last_scan_id)
      VALUES (?,?,'','in',1,?,?,?,?)`,
      [pass.id, kit.org.id, kit.clock.now(), kit.clock.now(), kit.clock.now(), claimed.id],
    );
    kit.clock.advance(61_000);
    await cronWithInterleave(async () => {
      await run(kit.env.DB, 'DELETE FROM scan_presence WHERE pass_id=?', [pass.id]);
    });
    expect(
      await first(kit.env.DB, 'SELECT state,reason FROM scans WHERE id=?', [claimed.id]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expectUnavailable(
      await out(await act(scanner.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });

  it('safely retries a pristine claim pending past 15 seconds', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing pending claim');
    kit.clock.advance(20_000);
    const res = await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey });
    expect(res.status).toBe(200);
    expect(await out(res)).toMatchObject({ kind: 'ok', replay: false, scanId: claimed.id });
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [claimed.id]),
    ).toEqual({ state: 'done', reason: null });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  });

  it.each([
    ['pass revision', 'version = version + 1'],
    ['test-data quarantine', 'test_data_quarantined = 1'],
  ])(
    'masks an interrupted admission after %s, including subsequent retries',
    async (_change, mutation) => {
      const s = await kit.scanner({ mode: 'test', templateIds: [tpl] });
      const pass = await kit.scanPass(
        tpl,
        { memberName: 'Recovery Private Person' },
        { mode: 'test' },
      );
      const req = await stage(s, pass, key(), 'test');
      const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error('Missing pending claim');
      await run(
        kit.env.DB,
        `UPDATE scans SET pass_id = ?, template_id = ?, action_id = 'check_in',
      action_kind = 'check_in' WHERE id = ?`,
        [pass.id, tpl, claimed.id],
      );
      await run(
        kit.env.DB,
        `INSERT INTO scan_gates
      (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
      VALUES (?, 'check_in', '', ?, 'test', ?, 'check_in', 'in', 1, ?, ?, ?)`,
        [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), claimed.id],
      );
      await run(kit.env.DB, `UPDATE passes SET ${mutation} WHERE id = ?`, [pass.id]);
      kit.clock.advance(20_000);
      const response = await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey });
      expect(response.status).toBe(200);
      const result = await out(response);
      expectUnavailable(result);
      expect(JSON.stringify(result)).not.toContain('Recovery Private Person');
      expectUnavailable(
        await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey })),
      );
      const reused = await act(
        s.headers,
        { code: 'ZZZZ-NOPE', method: 'camera' },
        {
          idempotencyKey: req.idempotencyKey,
        },
      );
      expect(reused.status).toBe(422);
      expect(await reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(
        await first(kit.env.DB, 'SELECT state, outcome, reason FROM scans WHERE id = ?', [
          claimed.id,
        ]),
      ).toEqual({ state: 'failed', outcome: null, reason: 'stale' });
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
      expect(
        await rows('SELECT pass_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toHaveLength(0);
    },
  );

  it('quarantines a previously failed, unmarked claim if a gate still names it', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const req = await stage(s, pass, key());
    const claimed = await scanByKey(kit.env.DB, `s:${s.id}`, req.idempotencyKey);
    if (!claimed) throw new Error('Missing pending claim');
    await run(
      kit.env.DB,
      `INSERT INTO scan_gates
      (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
      VALUES (?, 'check_in', '', ?, 'live', ?, 'check_in', 'in', 1, ?, ?, ?)`,
      [pass.id, kit.org.id, tpl, kit.clock.now(), kit.clock.now(), claimed.id],
    );
    await run(kit.env.DB, "UPDATE scans SET state = 'failed' WHERE id = ?", [claimed.id]);
    expectUnavailable(
      await out(await act(s.headers, req.input, { idempotencyKey: req.idempotencyKey })),
    );
    expect(
      await first(kit.env.DB, 'SELECT state, reason FROM scans WHERE id = ?', [claimed.id]),
    ).toEqual({ state: 'failed', reason: 'stale' });
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });
}
