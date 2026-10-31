import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index.ts';
import { ManualClock } from '../src/worker/platform/clock.ts';
import { fixtures, makeEnv, makeSession, makeUser } from './helpers/index.ts';

// Everything else builds the app with fake stores. These go through the real worker export.
describe('worker entrypoint', () => {
  it('serves /health', async () => {
    const res = await SELF.fetch('https://wallet.test/health');
    expect(res.status).toBe(200);
  });

  it('resolves a real D1 session cookie and rejects an unknown one', async () => {
    const f = fixtures(await makeEnv({ DB: env.DB }), new ManualClock(Date.now()));
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id });
    const ok = await SELF.fetch('https://wallet.test/api/v1/session', {
      headers: { cookie: session.headers.cookie ?? '' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authenticated: true, user: { id: user.id } });

    const anon = await SELF.fetch('https://wallet.test/api/v1/session', {
      headers: { cookie: '__Host-wallet_sid=unknown' },
    });
    expect(await anon.json()).toMatchObject({ authenticated: false });
  });

  it('exports a queue consumer that acks invalid messages', async () => {
    const batch = createMessageBatch('wallet-jobs', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { kind: 'nope' } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, await makeEnv({ DB: env.DB }), ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['m1']);
  });

  it('exports a scheduled handler', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ cron: '* * * * *', scheduledTime: Date.now() }),
      await makeEnv({ DB: env.DB }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
  });
});
