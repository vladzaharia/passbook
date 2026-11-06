import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { CRON_HOOKS, DAILY_CRON, MINUTE_CRON } from '../../jobs/cron.ts';
import { CRON_QUERY_BUDGET } from '../../jobs/query-counter.ts';
import type { AppEnv } from '../../platform/env.ts';
import { buildDisplay, historyStatements } from './display.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
const app = createApp({ stores: fake.stores });
const call = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, env as AppEnv);

const MOUNTS = [
  '/api/v1/scan',
  '/api/v1/scanners',
  '/api/v1/scan-events',
  '/api/v1/scan-staff',
  '/api/v1/scans',
  '/api/v1/scan-display',
  '/api/v1/nfc',
];

describe('scanner routers', () => {
  it.each(MOUNTS)('%s is mounted and empty: unknown paths are a 404 problem', async (mount) => {
    for (const headers of [{}, fake.admin()]) {
      const res = await call(`${mount}/nothing-here`, headers);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('the OpenAPI document builds and lists the device API', async () => {
    const res = await call('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(
      Object.keys(doc.paths)
        .filter((p) => p.startsWith('/api/v1/scan/'))
        .sort(),
    ).toEqual([
      '/api/v1/scan/actions',
      '/api/v1/scan/passes/{passId}/assets/{name}',
      '/api/v1/scan/resolve',
      '/api/v1/scan/scans',
      '/api/v1/scan/session',
      '/api/v1/scan/stats',
      '/api/v1/scan/summary',
    ]);
  });
});

describe('scan cron hooks', () => {
  it('registers reconcile and backfill each minute and retention daily', () => {
    const names = (cron: string) => (CRON_HOOKS[cron] ?? []).map((h) => h.name);
    expect(names(MINUTE_CRON)).toEqual(expect.arrayContaining(['scan.reconcile', 'scan.backfill']));
    expect(names(DAILY_CRON)).toContain('scan.retention');
  });

  it('the hooks run inside the budget on an empty database', async () => {
    const queries: string[] = [];
    const counted = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              queries.push(sql);
              return target.prepare(sql);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    } as unknown as AppEnv;
    const { createServiceContext } = await import('../../platform/service-context.ts');
    const ctx = createServiceContext(counted);
    const hooks = [MINUTE_CRON, DAILY_CRON]
      .flatMap((cron) => CRON_HOOKS[cron] ?? [])
      .filter((h) => h.name.startsWith('scan.'));
    expect(hooks).toHaveLength(3);
    for (const hook of hooks) await hook.run(ctx);
    expect(queries.length).toBeLessThan(CRON_QUERY_BUDGET);
  });
});

describe('display stub (C17)', () => {
  const actor = {} as never;
  const ctx = {} as never;
  it('is identity-only for a known pass and null otherwise', () => {
    const display = buildDisplay(ctx, {
      actor,
      pass: { id: 'p1', title: 'Anna Popescu' },
      screen: 'ok',
    });
    expect(display).toMatchObject({
      screen: 'ok',
      identity: { holder: 'Anna Popescu', initials: 'AP' },
      panels: [],
    });
    expect(buildDisplay(ctx, { actor, pass: null, screen: 'refused' })).toBeNull();
  });

  it('historyStatements returns no statements', () => {
    const reader = historyStatements(
      {} as never,
      { history: [], ledger: [] },
      {
        passId: 'p1',
        orgId: 'o1',
        timeZone: 'UTC',
        now: 0,
      },
    );
    expect(reader.stmts).toEqual([]);
  });
});
