import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeEnv } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearOidcCache } from './checks.ts';
import { isDeployed } from './cron-check.ts';
import { clearStatusCache, getStatus, recordCronRun } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;
const okFetch = (async () =>
  new Response(JSON.stringify({ issuer: 'https://id.test' }))) as unknown as typeof fetch;

beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(async () => {
  clearStatusCache(env.DB);
  clearOidcCache();
  await run(env.DB, "DELETE FROM settings WHERE scope = 'system'");
});

const cron = (s: Awaited<ReturnType<typeof getStatus>>, name: string) =>
  s.components.find((c) => c.id === `cron:${name}`);

describe('status recheck and crons', () => {
  it('names the sign-in provider Polaris ID', async () => {
    const s = await getStatus(createServiceContext(base), { fetch: okFetch });
    expect(s.components.find((c) => c.kind === 'oidc')?.label).toBe('Polaris ID');
  });

  it('fresh skips the short cache', async () => {
    const clock = new ManualClock(Date.now());
    const ctx = createServiceContext(base, { clock });
    const first = await getStatus(ctx, { fetch: okFetch });
    clock.advance(1000);
    expect((await getStatus(ctx, { fetch: okFetch })).components[0]?.checkedAt).toBe(
      first.components[0]?.checkedAt,
    );
    const fresh = await getStatus(ctx, { fetch: okFetch, fresh: true });
    expect(fresh.components[0]?.checkedAt).toBe(clock.now());
  });

  it('accepts fresh=1 on the API and rejects other values', async () => {
    const ok = await app.request('/api/v1/status?fresh=1', { headers: fake.admin() }, base);
    expect(ok.status).toBe(200);
    const bad = await app.request('/api/v1/status?fresh=yes', { headers: fake.admin() }, base);
    expect(bad.status).toBe(422);
  });

  it('flags a deployed cron with no run in a day as no recent run', async () => {
    const deployed = { ...base, PUBLIC_BASE_URL: 'https://wallet.example.test' } as AppEnv;
    const clock = new ManualClock(2_000_000_000_000);
    const ctx = createServiceContext(deployed, { clock });
    const never = await getStatus(ctx, { fetch: okFetch });
    expect(cron(never, 'daily')).toMatchObject({
      state: 'degraded',
      detail: 'No recent run.',
      data: { noRecentRun: true },
    });
    await recordCronRun(ctx, 'daily');
    await recordCronRun(ctx, 'minute');
    const ran = await getStatus(ctx, { fetch: okFetch, fresh: true });
    expect(cron(ran, 'daily')?.state).toBe('verified');
    clock.advance(25 * 3_600_000);
    const stale = await getStatus(ctx, { fetch: okFetch, fresh: true });
    expect(cron(stale, 'daily')?.data).toMatchObject({ noRecentRun: true });
    expect(cron(stale, 'minute')?.detail).toBe('No recent run.');
  });

  it('keeps local crons quiet: no run is only configured', async () => {
    const local = { ...base, PUBLIC_BASE_URL: 'http://localhost:5173' } as AppEnv;
    const s = await getStatus(createServiceContext(local), { fetch: okFetch });
    expect(cron(s, 'daily')).toMatchObject({ state: 'configured', detail: 'No run recorded.' });
  });

  it('treats only https, non-loopback base URLs as deployed', () => {
    expect(isDeployed({ PUBLIC_BASE_URL: 'https://wallet.plrs.im' })).toBe(true);
    expect(isDeployed({ PUBLIC_BASE_URL: 'https://localhost:8787' })).toBe(false);
    expect(isDeployed({ PUBLIC_BASE_URL: 'http://wallet.test' })).toBe(false);
    expect(isDeployed({ PUBLIC_BASE_URL: 'not a url' })).toBe(false);
  });
});
