import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
});
