import { beforeAll, describe, expect, it } from 'vitest';
import { countD1, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import {
  ACTION,
  type BudgetKit,
  budgetKit,
  hasGate,
  hasReservation,
  outcome,
  traceD1,
  withTrace,
} from './action-approval-budget-fixture.ts';
import { counts, effects, seedCounts } from './repo-action-approval-budget-test-fixtures.ts';
import { codeOf, grantScanMembership, key, ORIGIN, type ScanKit } from './test-kit.ts';

let f: BudgetKit;
beforeAll(async () => {
  f = await budgetKit();
});

/** A real pass-operator session using an owned managed scanner has both CSRF authorities. */
async function managed(kit: ScanKit, template: string) {
  const scanner = await kit.scanner({
    templateIds: [template],
    settings: { letInAgain: 'manager' },
  });
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  await run(
    kit.env.DB,
    `INSERT INTO scanner_setups (scanner_id,org_id,mode,admin_session,admin_user_id)
    VALUES (?,?,'live',1,?)`,
    [scanner.id, kit.org.id, user.id],
  );
  const app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const scope = {
    orgId: kit.org.id,
    setupId: scanner.id,
    templateIds: [template],
    timeZone: 'UTC',
  };
  const post = (body: Record<string, unknown>) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1/scan/actions`,
        {
          method: 'POST',
          headers: { ...session.headers, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, scope }),
        },
        kit.env,
      ),
    );
  return { scanner, user, session, scope, post };
}

describe('approval action D1 budget and original scalar authority', () => {
  it('captures the manager and override with the claim and keeps a cold photo/history override within five trips', async () => {
    const { kit } = f;
    const template = await kit.scanTemplate('Approval, history and photo', {
      actions: [ACTION],
      display: {
        v: 1,
        header: { title: 'Welcome', subtitle: '{{history.lastScan.action}}' },
        variants: [
          {
            id: 'returning',
            name: 'Returning',
            when: { path: 'history.visits.total', gte: 1 },
            header: { title: 'Returning member' },
          },
        ],
        panels: [
          {
            id: 'p_history',
            rows: [
              { id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] },
            ],
          },
        ],
      },
    });
    const actor = await managed(kit, template);
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(template);
    const request = (extra: Record<string, unknown> = {}) => ({
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: ACTION.id,
      ...extra,
    });
    expect(await outcome(await actor.post(request()))).toMatchObject({ kind: 'ok' });
    const heads = await outcome(await actor.post(request()));
    expect(heads).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    if (!heads.scanId) throw new Error('Missing real heads-up scan');
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const hashRow = await first<{ pin_hash: string }>(
      kit.env.DB,
      'SELECT pin_hash FROM scan_staff WHERE id=?',
      [manager.id],
    );
    if (!hashRow) throw new Error('Missing captured authority');
    const real = kit.env.DB;
    const counted = countD1(real);
    const trace = traceD1(counted.db);
    Object.assign(kit.env, { DB: trace.db });
    try {
      expect((await actor.post({})).status).toBe(422);
      const guard = counted.count();
      counted.reset();
      trace.batches.length = 0;
      clearSettingsCache(trace.db);
      const response = await actor.post(
        request({
          overrideOf: heads.scanId,
          approval: { staffId: manager.id, pin: manager.pin },
        }),
      );
      const result = await outcome(response);
      expect(result).toMatchObject({
        kind: 'ok',
        scanId: expect.any(String),
        display: { variant: 'returning', header: { title: 'Returning member' } },
      });
      expect(result.display?.identity.photo?.url).toContain(
        `/passes/${pass.id}/assets/member.png?g=`,
      );
      expect(JSON.stringify(result.display)).toContain('Check in');
      expect(counted.count() - guard).toBeLessThanOrEqual(5);

      for (const { values } of trace.batches.flat()) expect(values).not.toContain(manager.pin);
      expect(JSON.stringify(result)).not.toContain(hashRow.pin_hash);
      expect(JSON.stringify(result)).not.toContain(manager.pin);
      for (const row of await all<{ data: string }>(
        real,
        'SELECT data FROM pass_events WHERE pass_id=?',
        [pass.id],
      )) {
        expect(row.data).not.toContain(manager.pin);
        expect(row.data).not.toContain(hashRow.pin_hash);
      }
      expect(
        await first(real, 'SELECT approved_by,override_of FROM scans WHERE id=?', [result.scanId!]),
      ).toEqual({ approved_by: manager.id, override_of: heads.scanId });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });

  const EXPECTED = {
    'session revoked before reservation': null,
    'session revoked before gate': [403, 'ACTOR_CHANGED'],
    'scanner csrf rotated before gate': [403, 'ACTOR_CHANGED'],
  } as const;
  it.each([
    'session revoked before reservation',
    'session revoked before gate',
    'scanner csrf rotated before gate',
  ] as const)('uses the original actor/session/CSRF when %s', async (change) => {
    const { kit, managerTemplate } = f;
    const actor = await managed(kit, managerTemplate);
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(managerTemplate);
    await seedCounts(kit, actor.scanner.id, manager.id, 2, 3);
    const before = await effects(kit, pass.id);
    const sessionId = await hashSessionCookie(actor.session.cookieValue);
    const real = kit.env.DB;
    let raced = false;
    const { result } = await withTrace(
      kit,
      {
        before: async (batch) => {
          if (
            raced ||
            !(change === 'session revoked before reservation'
              ? hasReservation(batch)
              : hasGate(batch))
          )
            return;
          raced = true;
          if (change === 'scanner csrf rotated before gate')
            await run(
              real,
              'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
              [kit.fx.ids.token(), actor.scanner.id],
            );
          else
            await run(real, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
              kit.clock.now(),
              sessionId,
            ]);
        },
      },
      () =>
        actor.post({
          idempotencyKey: key(),
          input: codeOf(pass),
          clientTs: kit.clock.now(),
          actionId: ACTION.id,
          approval: { staffId: manager.id, pin: manager.pin },
        }),
    );
    expect(raced).toBe(true);
    const expected = EXPECTED[change];
    if (expected) {
      expect(result.status).toBe(expected[0]);
      expect(await result.json()).toMatchObject({ code: expected[1] });
    } else {
      // Revoked before the reservation: the guess is never spent and nothing is revealed.
      expect(await outcome(result)).toMatchObject({ kind: 'refused', reason: 'not_found' });
    }
    expect(await effects(kit, pass.id)).toEqual(before);
    expect(await counts(kit, actor.scanner.id, manager.id)).toEqual({ person: 2, scanner: 3 });
  });
});
