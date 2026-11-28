import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { admitTokenSession } from '../../platform/auth-workbench.ts';
import { run } from '../../platform/db.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

/** The key routes run as the sandbox's person; a person who no longer holds is refused, not swapped in. */
describe('Sandbox token person swap', () => {
  async function keysList(mutate?: (d: Awaited<ReturnType<typeof t.developer>>) => Promise<void>) {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    await mutate?.(d);
    return t.call('GET', `/api-keys?orgId=${d.made.orgId}`, t.asClient(token));
  }

  it('serves the person while everything holds', async () => {
    expect((await keysList()).status).toBe(200);
  });

  it('refuses a revoked membership', async () => {
    const res = await keysList((d) =>
      run(t.kit.env.DB, 'UPDATE org_memberships SET revoked_at = ?1 WHERE user_id = ?2', [
        t.kit.clock.now(),
        d.user.id,
      ]).then(() => undefined),
    );
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('refuses a revoked session', async () => {
    const res = await keysList((d) =>
      run(t.kit.env.DB, 'UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2', [
        t.kit.clock.now(),
        d.user.id,
      ]).then(() => undefined),
    );
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('refuses once the session has expired', async () => {
    const res = await keysList(async () => {
      t.kit.clock.advance(31 * 86_400_000);
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('refuses a disabled user', async () => {
    const res = await keysList((d) =>
      run(t.kit.env.DB, `UPDATE users SET status = 'disabled' WHERE id = ?1`, [d.user.id]).then(
        () => undefined,
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(401);
  });

  it('applies the org api plan level after the swap', async () => {
    const d = await t.developer();
    await run(
      t.kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?1, 'api', '"off"', 1)`,
      [d.made.orgId],
    );
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    await expectProblem(
      await t.call('GET', `/api-keys?orgId=${d.made.orgId}`, t.asClient(token)),
      403,
      'FEATURE_NOT_INCLUDED',
    );
  });

  it('asks the swapped person for a recent sign-in to make a key', async () => {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    t.kit.clock.advance(11 * 60_000);
    await expectProblem(
      await t.call('POST', '/api-keys', t.asClient(token), {
        orgId: d.made.orgId,
        name: 'late',
        kind: 'service',
        scopes: ['passes:read'],
        expiresAt: t.kit.clock.now() + 86_400_000,
      }),
      403,
      'STEP_UP_REQUIRED',
    );
  });

  it('admission re-checks the own-sandbox exemption instead of trusting the flag', async () => {
    const d = await t.developer();
    const other = await t.developer();
    t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'true';
    try {
      const person = (orgId: string, roles: SessionAuth['roles']): SessionAuth => ({
        kind: 'session',
        userId: d.user.id,
        sessionId: 'h',
        roles,
        csrfSecret: '',
        amr: 'oidc',
        mode: 'test',
        via: 'try',
        workbench: { orgId, subject: 'member' },
      });
      const admit = (s: SessionAuth) =>
        admitTokenSession(
          // The refusal path reads only the env, the stores and the principal.
          {
            env: t.kit.env,
            var: { stores: {} },
            set: () => undefined,
            get: () => undefined,
          } as never,
          s,
          { sessionKind: 'tenant', ownOnlyAdmitted: false, ownSandbox: true },
        );
      // Not their sandbox.
      await expect(admit(person(other.made.orgId, ['user', 'developer']))).rejects.toMatchObject({
        code: 'CONSOLE_ACCESS_REQUIRED',
      });
      // Their sandbox, but no developer role.
      await expect(admit(person(d.made.orgId, ['user']))).rejects.toMatchObject({
        code: 'CONSOLE_ACCESS_REQUIRED',
      });
    } finally {
      t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'false';
    }
  });
});
