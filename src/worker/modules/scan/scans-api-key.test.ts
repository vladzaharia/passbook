import { describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makePass,
  makeScanner,
  makeSession,
  runOne,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { authorizeApiKeys } from '../api-keys/access.ts';
import { createApiKey, createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import {
  clock,
  ctx,
  env,
  f,
  fake,
  get,
  items,
  liveReleaseId,
  ORIGIN,
  orgId,
  passId,
  post,
  type Rec,
  recordedAction,
  recordedNoMatch,
  recordVersion,
  scannerFixture,
  seed,
  template,
  userId,
} from './repo-scans-split-test-fixtures.ts';

describe('GET /scans (API key)', () => {
  it('sees its org only and its mode, with action identifiers and no names', async () => {
    const other = await makeOrg(f);
    const mine = await recordedAction(scannerFixture, passId);
    await seed({ mode: 'test' });
    await seed({
      org_id: other.id,
      pass_id: null,
      template_id: null,
      event_id: null,
      staff_id: null,
      scanner_id: null,
    });
    const res = await get('', fake.apiKey({ orgId, scopes: ['scans:read'] }));
    expect(res.status).toBe(200);
    expect((await get('?q=Anna', fake.apiKey({ orgId, scopes: ['scans:read'] }))).status).toBe(403);
    const rows = await items(res);
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    expect(rows[0]).toMatchObject({
      passId,
      templateId: template.resolved.id,
      externalId: null,
      kind: 'check_in',
      actionId: 'enter',
      amount: null,
      before: null,
      after: null,
    });
    const keys = Object.keys(rows[0] ?? {});
    expect(keys).toEqual(
      expect.arrayContaining(['id', 'at', 'passId', 'externalId', 'outcome', 'scannerName']),
    );
    for (const banned of [
      'passTitle',
      'staffName',
      'staffId',
      'approvedBy',
      'actor',
      'actionLabel',
    ])
      expect(keys).not.toContain(banned);
    expect(JSON.stringify(rows)).not.toContain('Dana');
    expect(JSON.stringify(rows)).not.toContain('Alex Morgan');
    const test = await items(
      await get('', fake.apiKey({ orgId, scopes: ['scans:read'], mode: 'test' })),
    );
    expect(test).toHaveLength(1);
    expect(test[0]?.id).not.toBe(mine.id);
  });

  it('returns proven opaque identifiers without any per-pass R2 reads', async () => {
    const expected = [await recordedAction(scannerFixture, passId)];
    for (let index = 0; index < 4; index++) {
      const pass = await makePass(f, { orgId, template: template.resolved });
      await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [liveReleaseId, pass.id]);
      await recordVersion(pass.id);
      expected.push(await recordedAction(scannerFixture, pass.id));
    }
    const key = fake.apiKey({ orgId, scopes: ['scans:read'] });
    const bucket = env.BUCKET;
    let bucketCalls = 0;
    const proxy = new Proxy(bucket, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          bucketCalls++;
          return value.apply(target, args);
        };
      },
    });
    Object.assign(env, { BUCKET: proxy });
    let response: Response;
    try {
      response = await get('?limit=20', key);
    } finally {
      Object.assign(env, { BUCKET: bucket });
    }
    expect(response.status).toBe(200);
    const rows = await items(response);
    expect(rows.map((row) => row.id)).toEqual(expected.reverse().map((row) => row.id));
    expect(rows.every((row) => row.passId && row.templateId === template.resolved.id)).toBe(true);
    expect(rows.every((row) => row.kind === 'check_in' && row.actionId === 'enter')).toBe(true);
    expect(bucketCalls).toBe(0);
  });

  it('an org key cannot name another org; a platform key can pick one', async () => {
    const other = await makeOrg(f);
    await seed();
    const key = fake.apiKey({ orgId, scopes: ['scans:read'] });
    expect((await get(`?orgId=${other.id}`, key)).status).toBe(403);
    expect(
      await items(
        await get(`?orgId=${orgId}`, fake.apiKey({ orgId: null, scopes: ['scans:read'] })),
      ),
    ).toHaveLength(1);
    expect(
      await items(
        await get(`?orgId=${other.id}`, fake.apiKey({ orgId: null, scopes: ['scans:read'] })),
      ),
    ).toHaveLength(0);
  });

  it('retains suspended-organization history for a platform-scoped key', async () => {
    const other = await makeOrg(f);
    const otherScanner = await makeScanner(f, {
      orgId: other.id,
      settings: { acceptAllTemplates: true },
    });
    // The global feed spans every org this file's earlier tests left behind; be the newest rows
    // while staying inside the fixture event's hour.
    clock.advance(10 * 60_000);
    const visible = await recordedNoMatch(scannerFixture);
    const hidden = await recordedNoMatch(otherScanner);
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other.id]);
    const key = fake.apiKey({ orgId: null, scopes: ['scans:read'] });
    const response = await get('?limit=1', key);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { items: Rec[]; nextCursor: string | null };
    expect(result.items.map((row) => row.id)).toEqual([hidden.id]);
    if (!result.nextCursor)
      throw new Error('The global feed must continue to the active organization.');
    const next = await get(`?limit=1&cursor=${encodeURIComponent(result.nextCursor)}`, key);
    expect(next.status).toBe(200);
    expect((await items(next)).map((row) => row.id)).toEqual([visible.id]);
    const scoped = await get(`?orgId=${other.id}`, key);
    expect(scoped.status).toBe(200);
    expect((await items(scoped)).map((row) => row.id)).toEqual([hidden.id]);
  });

  it('needs the scans:read scope, and opens no other scans route', async () => {
    const row = await seed();
    expect((await get('', fake.apiKey({ orgId, scopes: ['passes:read'] }))).status).toBe(403);
    const key = fake.apiKey({ orgId, scopes: ['scans:read'] });
    expect((await get(`/${row.id}`, key)).status).toBe(401);
    expect((await get(`/export?orgId=${orgId}&from=0&to=1`, key)).status).toBe(401);
    expect(
      (
        await post(
          `/${row.id}/undo`,
          { idempotencyKey: '018f0000-0000-7000-8000-000000000000' },
          key,
        )
      ).status,
    ).toBe(401);
  });

  it('rejects in-place scope changes while the original real key remains usable', async () => {
    const row = await recordedAction(scannerFixture, passId);
    const fixture = await makeApiKey(f, { orgId, scopes: ['scans:read'] });
    await expect(
      run(env.DB, 'UPDATE api_keys SET scopes = ? WHERE id = ?', ['["passes:read"]', fixture.id]),
    ).rejects.toThrow();
    expect(
      await first(env.DB, 'SELECT scopes, revoked_at FROM api_keys WHERE id = ?', [fixture.id]),
    ).toEqual({ scopes: '["scans:read"]', revoked_at: null });
    const keyApp = createApp({
      stores: {
        ...fake.stores,
        sessions: createSessionStore(env, clock),
        apiKeys: createApiKeyStore(env, clock),
        scanners: createScannerStore(env, clock),
      },
      clock,
    });
    const response = await keyApp.request(
      `${ORIGIN}/api/v1/scans?orgId=${orgId}`,
      { headers: fixture.headers },
      env,
    );
    expect(response.status).toBe(200);
    expect((await items(response)).map((item) => item.id)).toEqual([row.id]);
  });

  it.each([
    'revoked',
    'expired',
    'replaced with fewer scopes',
    'replaced with broader scopes',
    'org suspended',
  ] as const)(
    'does not return feed data when the persisted key is %s before the output fence',
    async (change) => {
      const row = await recordedAction(scannerFixture, passId);
      const creator = await makeSession(f, { userId, roles: ['admin', 'user'] });
      const auth = await createSessionStore(env, clock).resolve(creator.cookieValue);
      if (!auth) throw new Error('Missing API key creator session');
      const authority = await authorizeApiKeys(ctx, auth, orgId, 'integrations:manage');
      const issued = await createApiKey(ctx, authority, {
        orgId,
        name: 'Output-fence key',
        scopes: ['scans:read'],
        mode: 'live',
        expiresAt: clock.now() + 60_000,
      });
      const fixture = { id: issued.id, headers: { authorization: `Bearer ${issued.secret}` } };
      const keyApp = createApp({
        stores: {
          ...fake.stores,
          sessions: createSessionStore(env, clock),
          apiKeys: createApiKeyStore(env, clock),
          scanners: createScannerStore(env, clock),
        },
        clock,
      });
      const send = () =>
        Promise.resolve(
          keyApp.request(
            `${ORIGIN}/api/v1/scans?orgId=${orgId}`,
            { headers: fixture.headers },
            env,
          ),
        );
      const initial = await send();
      expect(initial.status).toBe(200);
      expect((await items(initial)).map((item) => item.id)).toEqual([row.id]);
      const db = env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, prop) {
            if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (prop === 'all')
              return async () => {
                const result = await target.all();
                if (intercepted === 0) {
                  intercepted++;
                  if (change === 'org suspended') {
                    await runOne(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
                  } else if (
                    change === 'replaced with fewer scopes' ||
                    change === 'replaced with broader scopes'
                  ) {
                    expect(
                      await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                        clock.now(),
                        fixture.id,
                      ]),
                    ).toEqual({ changes: 1 });
                    const replacement = await makeApiKey(
                      { ...f, env: { ...env, DB: db } },
                      {
                        orgId,
                        scopes:
                          change === 'replaced with fewer scopes'
                            ? ['passes:read']
                            : ['scans:read', 'passes:read'],
                      },
                    );
                    expect(replacement.id).not.toBe(fixture.id);
                  } else if (change === 'expired') {
                    clock.advance(60_000);
                  } else {
                    expect(
                      await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                        clock.now(),
                        fixture.id,
                      ]),
                    ).toEqual({ changes: 1 });
                  }
                }
                return result;
              };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const proxy = new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              return /FROM\s+scans\s+s[\s\S]*ORDER BY s\.at DESC/i.test(sql)
                ? wrap(statement)
                : statement;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(env, { DB: proxy });
      let response: Response;
      try {
        response = await send();
      } finally {
        Object.assign(env, { DB: db });
      }
      expect(intercepted).toBe(1);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code: 'INVALID_API_KEY' });
      for (const value of [row.id, passId, template.resolved.id, 'Alex Morgan'])
        expect(body).not.toContain(value);
    },
  );
});
