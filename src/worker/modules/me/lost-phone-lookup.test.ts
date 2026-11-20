import { describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { Job } from '../../jobs/types.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupScanKit } from '../scan/test-kit.ts';

describe('I lost my phone on a pass with a desk lookup', () => {
  it('replaces the code twice: the lookup value is not a credential', async () => {
    const kit = await setupScanKit();
    kit.env.JOBS = { send: vi.fn(async (_: Job) => {}), sendBatch: vi.fn() } as unknown as Queue;
    kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
    const templateId = await kit.scanTemplate('Lookup', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      lookup: { input: 'memberNo' },
    });
    const user = await makeUser(kit.fx);
    const pass = await kit.scanPass(
      templateId,
      { memberNo: 'M-1001' },
      { holderEmail: user.primaryEmail },
    );
    const mine = await makeSession(kit.fx, { userId: user.id });
    const app = createApp({
      clock: kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    });
    const lost = () =>
      Promise.resolve(
        app.request(
          `https://example.test/api/v1/me/passes/${pass.id}/lost-phone`,
          { method: 'POST', headers: mine.headers },
          kit.env,
        ),
      );
    const first = await lost();
    expect(first.status).toBe(202);
    const afterFirst = await getPass(kit.env.DB, pass.id);
    expect(afterFirst?.scanCode).not.toBe(pass.scanCode);
    expect((await lost()).status).toBe(202);
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).not.toBe(afterFirst?.scanCode);
  });
});
