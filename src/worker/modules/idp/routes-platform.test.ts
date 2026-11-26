import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { removeFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import {
  DriftListSchema,
  FrozenSchema,
  IdpCallListSchema,
  IdpStatusSchema,
} from '../../../shared/contracts/idp-access.ts';
import { admin, f, installOpsRig, rig, start } from './ops-test-fixtures.ts';
import { recordDrift } from './repo-drift.ts';

installOpsRig();

const P = '/api/v1/platform/idp';

describe('platform routes', () => {
  it('are for platform admins; freeze needs a Polaris ID sign-in', async () => {
    const key = await makeApiKey(f());
    const routes: [string, string][] = [
      ['GET', P],
      ['GET', `${P}/drift`],
      ['GET', `${P}/calls?since=0`],
      ['POST', `${P}/freeze`],
    ];
    for (const [method, path] of routes) {
      expect((await start(path, method, {})).status).toBe(401);
      expect((await start(path, method, key.headers)).status).toBe(401);
      await expectProblem(
        await start(path, method, (await admin(['user'])).headers),
        403,
        'FORBIDDEN',
      );
    }
    await expectProblem(
      await start(`${P}/freeze`, 'POST', (await admin(['admin', 'user'], 'magic_link')).headers, {
        reason: 'testing',
      }),
      403,
      'IDP_SIGN_IN_REQUIRED',
    );
  });

  it('reports the status, and a missing binding as not connected', async () => {
    const a = await admin();
    const ok = IdpStatusSchema.parse(await (await start(P, 'GET', a.headers)).json());
    expect(ok).toMatchObject({ connected: true, mode: 'live', frozen: false, breakerOpen: false });
    removeFakeIdp(rig.h.env);
    const gone = IdpStatusSchema.parse(await (await start(P, 'GET', a.headers)).json());
    expect(gone).toMatchObject({ connected: false, mode: null, frozen: null });
  });

  it('lists open differences', async () => {
    await recordDrift(rig.h.env.DB, {
      id: 'drift-1',
      runId: 'run-1',
      userId: null,
      subject: 'sub-x',
      target: 'console',
      kind: 'unknown_member',
      now: rig.h.clock.now(),
    });
    const a = await admin();
    const list = DriftListSchema.parse(await (await start(`${P}/drift`, 'GET', a.headers)).json());
    expect(list.items).toContainEqual({
      id: 'drift-1',
      userId: null,
      target: 'console',
      kind: 'unknown_member',
      foundAt: rig.h.clock.now(),
    });
  });

  it('freezes once and audits it', async () => {
    const a = await admin();
    const body = { reason: 'owner asked' };
    const first = FrozenSchema.parse(
      await (await start(`${P}/freeze`, 'POST', a.headers, body)).json(),
    );
    expect(first.result).toBe('frozen');
    expect(rig.idp.frozen).toBe(true);
    // The binding takes a code; what the admin typed stays in PassBook's audit log.
    expect(rig.idp.freezeReason).toBe('admin_pause');
    const audit = await rig.h.env.DB.prepare(
      "SELECT detail FROM audit_log WHERE action = 'idp.freeze'",
    ).first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? '{}')).toEqual({ reason: 'owner asked' });
    const again = FrozenSchema.parse(
      await (await start(`${P}/freeze`, 'POST', a.headers, body)).json(),
    );
    expect(again.result).toBe('already');
    expect((await start(`${P}/freeze`, 'POST', a.headers, { reason: '' })).status).toBe(422);
  });

  it('answers a repeated Idempotency-Key for freeze from the first call', async () => {
    const a = await admin();
    const headers = { ...a.headers, 'idempotency-key': 'freeze-1' };
    const body = { reason: 'owner asked' };
    await start(`${P}/freeze`, 'POST', headers, body);
    const again = await start(`${P}/freeze`, 'POST', headers, body);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(FrozenSchema.parse(await again.json()).result).toBe('frozen');
  });

  it('reads the binding ledger', async () => {
    const a = await admin();
    await start(P, 'GET', a.headers);
    const res = await start(`${P}/calls?since=0`, 'GET', a.headers);
    expect(res.status).toBe(200);
    const list = IdpCallListSchema.parse(await res.json());
    expect(list.nextCursor).toBeNull();
    expect((await start(`${P}/calls`, 'GET', a.headers)).status).toBe(422);
  });
});
