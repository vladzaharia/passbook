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

// The canonical origin vitest.config.ts pins; the real entry refuses other hosts.
const ORIGIN = env.PUBLIC_BASE_URL;

// Everything else builds the app with fake stores. These go through the real worker export.
describe('worker entrypoint', () => {
  it('serves /health', async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
  });

  it('redirects a REDIRECT_HOSTS host and refuses an unknown one', async () => {
    const moved = await SELF.fetch(`https://${env.REDIRECT_HOSTS}/p/abc?x=1`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(moved.status).toBe(308);
    expect(moved.headers.get('location')).toBe(`${ORIGIN}/p/abc?x=1`);
    const unknown = await SELF.fetch('https://elsewhere.test/health');
    expect(unknown.status).toBe(421);
    expect(await unknown.json()).toMatchObject({ code: 'HOST_UNKNOWN' });
  });

  it('resolves a real D1 session cookie and rejects an unknown one', async () => {
    const f = fixtures(await makeEnv({ DB: env.DB }), new ManualClock(Date.now()));
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id });
    const ok = await SELF.fetch(`${ORIGIN}/api/v1/session`, {
      headers: { cookie: session.headers.cookie ?? '' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authenticated: true, user: { id: user.id } });

    const anon = await SELF.fetch(`${ORIGIN}/api/v1/session`, {
      headers: { cookie: '__Host-wallet_sid=unknown' },
    });
    expect(await anon.json()).toMatchObject({ authenticated: false });
  });

  it('resolves sessions against the env of each request, not the first one seen', async () => {
    const f = fixtures(await makeEnv({ DB: env.DB }), new ManualClock(Date.now()));
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id });
    const request = () =>
      new Request(`${ORIGIN}/api/v1/session`, {
        headers: { cookie: session.headers.cookie ?? '' },
      });
    const run = async (e: Awaited<ReturnType<typeof makeEnv>>) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(request(), e, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    await run(await makeEnv({ DB: env.DB }));
    let prepared = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            prepared++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const second = await run(await makeEnv({ DB: counting }));
    expect(await second.json()).toMatchObject({ authenticated: true });
    expect(prepared).toBeGreaterThan(0);
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
