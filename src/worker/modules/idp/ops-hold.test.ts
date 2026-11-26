import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { bump } from '../../platform/counters.ts';
import { all, first } from '../../platform/db.ts';
import {
  admin,
  installOpsRig,
  opOf,
  paused,
  read,
  rig,
  runNext,
  start,
} from './ops-test-fixtures.ts';
import { BREAKER_KEY } from './scim-effects.ts';

installOpsRig();

describe('restore', () => {
  const url = (id: string, role = 'console') => `/api/v1/users/${id}/holds/${role}`;

  it('clears the pause, adds the role and reads it back', async () => {
    const p = await paused();
    const a = await admin();
    const res = await start(url(p.user.id), 'DELETE', a.headers);
    expect(res.status).toBe(202);
    const op = await opOf(res);
    expect(op).toMatchObject({ kind: 'idp.restore', target: { type: 'user_role' } });
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.steps.map((s) => [s.key, s.state])).toEqual([
      ['release', 'done'],
      ['apply', 'done'],
      ['confirm', 'done'],
    ]);
    expect(rig.idp.accounts.get(p.subject)?.roles.has('console')).toBe(true);
    const row = await first<{ held_at: number | null; observed: number }>(
      rig.h.env.DB,
      'SELECT held_at, observed FROM idp_target_state WHERE subject = ? AND target = ?',
      [p.subject, 'console'],
    );
    expect(row).toEqual({ held_at: null, observed: 1 });
    const audit = await all<{ action: string }>(
      rig.h.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'idp.restore'",
      [p.user.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses a role that is not paused, and a stranger', async () => {
    const p = await paused();
    const a = await admin();
    await expectProblem(
      await start(url(p.user.id, 'developer'), 'DELETE', a.headers),
      409,
      'IDP_NOT_HELD',
    );
    await expectProblem(
      await start(url('00000000-0000-7000-8000-000000000000'), 'DELETE', a.headers),
      404,
      'USER_NOT_FOUND',
    );
  });

  it('only touches the user and role it was started for', async () => {
    const p = await paused();
    const other = await paused();
    const a = await admin();
    const op = await opOf(await start(url(p.user.id), 'DELETE', a.headers));
    await runNext(op);
    expect(rig.idp.accounts.get(other.subject)?.roles.has('console')).toBe(false);
    const stillHeld = await first<{ held_at: number | null }>(
      rig.h.env.DB,
      'SELECT held_at FROM idp_target_state WHERE subject = ? AND target = ?',
      [other.subject, 'console'],
    );
    expect(stillHeld?.held_at).not.toBeNull();
  });

  it('a repeat with the same Idempotency-Key answers the first operation', async () => {
    const p = await paused();
    const a = await admin();
    const headers = { ...a.headers, 'idempotency-key': 'restore-1' };
    const one = await opOf(await start(url(p.user.id), 'DELETE', headers));
    const two = await opOf(await start(url(p.user.id), 'DELETE', headers));
    expect(two.id).toBe(one.id);
    expect(rig.queue.jobs).toHaveLength(1);
  });
});

describe('SCIM breaker clear', () => {
  const clear = (headers: Record<string, string>) =>
    start('/api/v1/platform/idp/scim-breaker/clear', 'POST', headers);
  const latched = () =>
    first<{ n: number }>(rig.h.env.DB, 'SELECT count(*) AS n FROM counters WHERE key = ?', [
      BREAKER_KEY,
    ]);

  it('refuses when it is not tripped', async () => {
    await expectProblem(await clear((await admin()).headers), 409, 'IDP_BREAKER_CLOSED');
  });

  it('deletes the latch and says what is owed', async () => {
    await bump(rig.h.env.DB, BREAKER_KEY, rig.h.clock.now());
    expect((await latched())?.n).toBe(1);
    const a = await admin();
    const res = await clear(a.headers);
    expect(res.status).toBe(202);
    const op = await opOf(res);
    expect(op.kind).toBe('idp.breaker_clear');
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result?.ids).toEqual({ owed: '0' });
    expect((await latched())?.n).toBe(0);
    const audit = await all<{ action: string }>(
      rig.h.env.DB,
      "SELECT action FROM audit_log WHERE action = 'idp.breaker_clear'",
    );
    expect(audit).toHaveLength(1);
  });
});
