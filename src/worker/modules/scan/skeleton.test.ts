import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { CRON_HOOKS, DAILY_CRON, MINUTE_CRON } from '../../jobs/cron.ts';
import { CRON_QUERY_BUDGET } from '../../jobs/query-counter.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { buildDisplay } from './display.ts';
import { isFinalizedDisplayHistory, prepareDisplayHistory } from './scan-display-history.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
const app = createApp({ stores: fake.stores });
const call = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, env as AppEnv);

/** Unknown paths on the scanner mounts remain 404 problems. */
const MOUNTS = ['/api/v1/scan', '/api/v1/scan-staff', '/api/v1/scan-display', '/api/v1/nfc'];

describe('scanner routers', () => {
  it.each(MOUNTS)('%s is mounted and empty: unknown paths are a 404 problem', async (mount) => {
    for (const headers of [{}, fake.admin()]) {
      const res = await call(`${mount}/nothing-here`, headers);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('the OpenAPI document builds with device and console scan paths', async () => {
    const res = await call('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/scanners',
        '/api/v1/scan-events',
        '/api/v1/scans',
        '/api/v1/scan/actions',
        '/api/v1/scan/resolve',
        '/api/v1/scan/session',
        '/api/v1/scan-display/preview',
      ]),
    );
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
    const ctx = jobCtxOf({ ctx: createServiceContext(counted) });
    const hooks = [MINUTE_CRON, DAILY_CRON]
      .flatMap((cron) => CRON_HOOKS[cron] ?? [])
      .filter((h) => h.name.startsWith('scan.'));
    expect(hooks).toHaveLength(3);
    for (const hook of hooks) await hook.run(ctx);
    expect(queries.length).toBeLessThan(CRON_QUERY_BUDGET);
  });
});

describe('display without a template', () => {
  const actor = {} as never;
  const ctx = {} as never;
  it('uses a generic identity when the title provenance is unknown, and null without a pass', () => {
    const display = buildDisplay(ctx, {
      actor,
      pass: { id: 'p1', title: 'Anna Popescu' },
      screen: 'ok',
    });
    expect(display).toMatchObject({
      screen: 'ok',
      identity: { holder: 'Pass', initials: 'P' },
      panels: [],
    });
    expect(buildDisplay(ctx, { actor, pass: null, screen: 'refused' })).toBeNull();
  });

  it('binds even empty display history to output authority and its original scope', async () => {
    const credentialKeysetCommitment = await credentialRefKeysetCommitment(env);
    const historyActor = {
      principal: 'scanner',
      orgId: 'o1',
      mode: 'live',
      actorKey: 's:scanner',
      actor: { type: 'scanner', id: 'scanner' },
      role: 'door',
      timeZone: 'UTC',
      templateIds: [],
      credentialKeysetCommitment,
    };
    const found = {
      pass: { id: 'p1', orgId: 'o1', mode: 'live', templateId: 'tpl1' },
      credentialKeysetCommitment,
    };
    const service = createServiceContext(env as AppEnv);
    const plan = await prepareDisplayHistory(service, historyActor as never, found as never, {
      history: [],
      ledger: [],
    });
    const denied = plan.bind(service.clock.now(), { sql: '0', params: [] });
    expect(denied.stmts).toHaveLength(1);
    expect(denied.finalize(await env.DB.batch(denied.stmts))).toBeNull();

    const incomplete = plan.bind(service.clock.now(), { sql: '1', params: [] });
    expect(incomplete.stmts).toHaveLength(1);
    expect(incomplete.finalize([])).toBeNull();
    const bound = plan.bind(service.clock.now(), { sql: '1', params: [] });
    const results = await env.DB.batch(bound.stmts);
    const history = bound.finalize(results);
    expect(bound.finalize(results)).toBeNull();
    expect(history?.value).toEqual({});
    expect(isFinalizedDisplayHistory(history, historyActor as never, found as never)).toBe(true);
    expect(isFinalizedDisplayHistory(history, { ...historyActor } as never, found as never)).toBe(
      false,
    );
    expect(isFinalizedDisplayHistory({ value: {} }, historyActor as never, found as never)).toBe(
      false,
    );
  });
});
