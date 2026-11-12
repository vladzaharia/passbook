import { expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { expectBlocked, raceGate, tenantActor } from './act-authority-test-fixtures.ts';
import { act, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { codeOf, grantScanMembership, key } from './test-kit.ts';

// The kit's fake session store cannot resolve cookies persisted by makeSession, so a tenant session
// goes through an app that reads the real session table.
const sessionAct: typeof act = async (headers, input, over = {}) =>
  createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  }).request(
    'https://wallet.test/api/v1/scan/actions',
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: key(),
        input,
        clientTs: kit.clock.now(),
        actionId: 'auto',
        ...over,
      }),
    },
    kit.env,
  );

export function registerAuthorityMisses() {
  it('does not increment misses when actor revocation wins the stop transaction', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      { code: 'STALE-MISS-INPUT', method: 'camera' },
      (db) => run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]),
      { idempotencyKey },
      commitBatchSql,
    );
    await expectBlocked(response, 'no-pass', idempotencyKey, 'SCANNER_REPAIR');
    const counterKey = `scan:miss:${JSON.stringify([kit.org.id, 'live', `s:${scanner.id}`])}`;
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=?', [counterKey]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
        [scanner.id],
      ),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT state,outcome FROM scans WHERE idempotency_key=?', [
        idempotencyKey,
      ]),
    ).toSatisfy((row) => row === null || (row.state === 'failed' && row.outcome === null));
  });

  it('counts a miss once, caps the 31st and replays without increment or duplicate audit', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const input = { code: 'CAPPED-MISS-INPUT', method: 'camera' };
    for (let n = 0; n < 30; n++) expect((await act(scanner.headers, input)).status).toBe(200);
    const idempotencyKey = key();
    const capped = await act(scanner.headers, input, { idempotencyKey });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ code: 'SCAN_TOO_MANY_MISSES' });
    const counterKey = `scan:miss:${JSON.stringify([kit.org.id, 'live', `s:${scanner.id}`])}`;
    expect(await first(kit.env.DB, 'SELECT count FROM counters WHERE key=?', [counterKey])).toEqual(
      { count: 31 },
    );
    expect(
      await rows("SELECT id FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?", [
        scanner.id,
      ]),
    ).toHaveLength(1);
    const replay = await out(await act(scanner.headers, input, { idempotencyKey }));
    expect(replay).toMatchObject({ kind: 'refused', reason: 'not_found', replay: true });
    expect(await first(kit.env.DB, 'SELECT count FROM counters WHERE key=?', [counterKey])).toEqual(
      { count: 31 },
    );
    expect(
      await rows("SELECT id FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?", [
        scanner.id,
      ]),
    ).toHaveLength(1);
  });

  it.each(['revoked', 'same-role regrant'] as const)(
    'refuses 403 ACTOR_CHANGED when the operating membership is %s after evaluation',
    async (change) => {
      const { user, membershipId, fixture } = await tenantActor('pass_operator', 'passes:operate');
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const response = await raceGate(
        { ...fixture.headers, 'x-passbook-mode': pass.mode, origin: 'https://wallet.test' },
        codeOf(pass),
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            membershipId,
          ]);
          if (change === 'same-role regrant')
            await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
        },
        {
          idempotencyKey,
          actionId: 'check_in',
          scope: { orgId: kit.org.id, templateIds: [tpl], timeZone: 'UTC' },
        },
        commitBatchSql,
        0,
        sessionAct,
      );
      await expectBlocked(response, pass.id, idempotencyKey, 'ACTOR_CHANGED');
      expect(
        await rows('SELECT pass_id FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toHaveLength(0);
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
    },
  );
}
