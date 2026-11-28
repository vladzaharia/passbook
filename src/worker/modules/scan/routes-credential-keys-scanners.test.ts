import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { tenantOrgAccessRevision } from '../passes/repo-authority.ts';
import { credentialKeysFixture, FORMAT } from './credential-keys-test-fixtures.ts';
import { createPairing } from './pairing.ts';
import { replaceTerminalToken } from './pairing-token.ts';
import { RACE_COUNTER_BUMP } from './race-tags.ts';
import { getConsoleScanner } from './repo-scanners.ts';

const t = credentialKeysFixture();
type Keys = Awaited<ReturnType<typeof t.keys>>;
let keys: Keys;
beforeAll(async () => {
  await t.setup();
  keys = await t.keys();
});

const MISSING = '0193a1b2-7c00-7000-8000-00000000ffff';
const paths = {
  pairing: (id: string) => `/scanners/${id}/pairing`,
  token: (id: string) => `/scanners/${id}/token`,
};
const ROUTES = [
  { name: 'pairing', kind: 'device', path: paths.pairing, action: 'scanner.pairing_create' },
  { name: 'token', kind: 'terminal', path: paths.token, action: 'scanner.token_replace' },
] as const;

const state = async (id: string) =>
  first<Record<string, unknown>>(
    t.env().DB,
    'SELECT pair_code_hash, token_hash, token_prefix, revoked_at, pair_expires_at FROM scanners WHERE id = ?',
    [id],
  );
const redeem = (code: string) =>
  t.fixture.call('POST', '/scan/pair', { code }, { origin: 'https://wallet.test' });

describe('pairing code by scanning:admin key', () => {
  it('shows the code once; a replay shows the same ids and no code', async () => {
    const s = await t.scanner();
    const path = paths.pairing(s.id);
    const first = await t.send('POST', path, keys.admin.headers, undefined, 'pair-once');
    const replay = await t.send('POST', path, keys.admin.headers, undefined, 'pair-once');
    const poll = await t.send('GET', path, keys.read.headers);
    const detail = await t.fixture.call('GET', `/scanners/${s.id}`);
    const shown = ((await first.clone().json()) as { code: string }).code;
    await t.expectOnce({
      first,
      replay,
      secrets: { code: FORMAT.code, url: FORMAT.url },
      ids: ['expiresAt'],
      keyId: keys.admin.id,
      action: 'scanner.pairing_create',
      target: s.id,
      reads: [await poll.text(), await detail.text()],
    });
    await t.expectIdempotencyScope({
      other: (await t.keys()).admin.headers,
      run: (h, variant) =>
        t.send('POST', `${path}${variant ? '?restore=true' : ''}`, h, undefined, 'pair-once'),
      secret: 'code',
      firstSecret: shown,
    });
  });

  it('a new code replaces the old one, which no longer redeems', async () => {
    const s = await t.scanner();
    const call = async () =>
      (
        (await (await t.send('POST', paths.pairing(s.id), keys.admin.headers)).json()) as {
          code: string;
        }
      ).code;
    const old = await call();
    const fresh = await call();
    expect(fresh).not.toBe(old);
    expect((await redeem(old)).status).toBe(400);
    expect((await redeem(fresh)).status).toBe(200);
    const row = await getConsoleScanner(t.env().DB, s.id);
    expect(row?.pairedAt).not.toBeNull();
    expect(await t.auditRows(s.id, 'scanner.pair')).toHaveLength(1);
  });

  it('writes no creator for a key', async () => {
    const s = await t.scanner();
    await t.send('POST', paths.pairing(s.id), keys.admin.headers);
    expect(
      await first(t.env().DB, 'SELECT pair_created_by FROM scanners WHERE id = ?', [s.id]),
    ).toEqual({ pair_created_by: null });
  });

  it('refuses a revoked scanner unless restore is sent, and audits the restore by the key', async () => {
    const s = await t.scanner();
    await t.fixture.call('POST', `/scanners/${s.id}/revoke`);
    await expectProblem(
      await t.send('POST', paths.pairing(s.id), keys.admin.headers),
      409,
      'SCANNER_REVOKED',
    );
    const res = await t.send('POST', `${paths.pairing(s.id)}?restore=true`, keys.admin.headers);
    expect(res.status).toBe(200);
    const [restore] = await t.auditRows(s.id, 'scanner.restore');
    expect(restore).toMatchObject({ actor_type: 'api_key', actor_id: keys.admin.id });
    expect((await state(s.id))?.revoked_at).toBeNull();
  });

  it('refuses a terminal', async () => {
    const till = await t.scanner('terminal');
    await expectProblem(
      await t.send('POST', paths.pairing(till.id), keys.admin.headers),
      422,
      'SCANNER_NOT_PAIRABLE',
    );
  });

  it('the poll goes from waiting to paired for a scan-setup:read key', async () => {
    const s = await t.scanner();
    const code = (
      (await (await t.send('POST', paths.pairing(s.id), keys.admin.headers)).json()) as {
        code: string;
      }
    ).code;
    const poll = async () =>
      (await (await t.send('GET', paths.pairing(s.id), keys.read.headers)).json()) as {
        state: string;
      };
    expect((await poll()).state).toBe('waiting');
    expect((await redeem(code)).status).toBe(200);
    expect((await poll()).state).toBe('paired');
  });

  it('keeps the console answer: a session gets the code, never null', async () => {
    const s = await t.scanner();
    const res = await t.fixture.call('POST', paths.pairing(s.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).toMatch(FORMAT.code);
  });
});

describe('till token by scanning:admin key', () => {
  it('shows the token once; the old one stops and the new one works', async () => {
    const till = await t.scanner('terminal');
    const path = paths.token(till.id);
    const first = await t.send('POST', path, keys.admin.headers, undefined, 'token-once');
    const replay = await t.send('POST', path, keys.admin.headers, undefined, 'token-once');
    const detail = await t.fixture.call('GET', `/scanners/${till.id}`);
    const token = ((await first.clone().json()) as { token: string }).token;
    await t.expectOnce({
      first,
      replay,
      secrets: { token: FORMAT.token },
      ids: ['expiresAt'],
      keyId: keys.admin.id,
      action: 'scanner.token_replace',
      target: till.id,
      reads: [await detail.text()],
    });
    await t.expectIdempotencyScope({
      other: (await t.keys()).admin.headers,
      run: (h, variant) =>
        t.send('POST', `${path}${variant ? '?restore=true' : ''}`, h, undefined, 'token-once'),
      secret: 'token',
      firstSecret: token,
    });
    const next = (
      (await (await t.send('POST', path, keys.admin.headers)).json()) as {
        token: string;
      }
    ).token;
    const use = (bearer: string) =>
      t.send('POST', '/scan/resolve', { authorization: `Bearer ${bearer}` }, {});
    expect((await use(token)).status).toBe(401);
    expect((await use(next)).status).not.toBe(401);
  });

  it('refuses a device', async () => {
    const s = await t.scanner();
    await expectProblem(
      await t.send('POST', paths.token(s.id), keys.admin.headers),
      422,
      'SCANNER_NOT_TERMINAL',
    );
  });
});

describe.each(ROUTES)('$name: who may call', (route) => {
  const target = () => t.scanner(route.kind);
  const call = (id: string, headers: Record<string, string>) =>
    t.send('POST', route.path(id), headers);

  it('refuses scanning:write and scan-setup:read with MISSING_SCOPE', async () => {
    const s = await target();
    // nfc:keys is a credential scope of its own: it opens no pairing or token.
    for (const k of [keys.write, keys.read, keys.nfc])
      await expectProblem(await call(s.id, k.headers), 403, 'MISSING_SCOPE');
    expect(await t.keyAudit(s.id, route.action)).toHaveLength(0);
  });

  it('gives a platform key 404, writing nothing', async () => {
    const s = await target();
    const [before, rows] = [await state(s.id), await t.auditCount()];
    await expectProblem(await call(s.id, keys.platform.headers), 404, 'SCANNER_NOT_FOUND');
    expect(await state(s.id)).toEqual(before);
    expect(await t.auditCount()).toBe(rows);
  });

  it("gives another org's key the same 404 as a missing id", async () => {
    const s = await target();
    const foreign = await call(s.id, keys.otherOrg.headers);
    const missing = await call(MISSING, keys.otherOrg.headers);
    expect(foreign.status).toBe(404);
    const strip = ({ requestId: _, ...problem }: Record<string, unknown>) => problem;
    expect(strip((await foreign.json()) as Record<string, unknown>)).toEqual(
      strip((await missing.json()) as Record<string, unknown>),
    );
  });

  it('gives a forced test-mode admin key 404 on a live scanner, writing nothing', async () => {
    const s = await target();
    const before = await state(s.id);
    await expectProblem(await call(s.id, keys.testAdmin.headers), 404, 'SCANNER_NOT_FOUND');
    expect(await state(s.id)).toEqual(before);
  });

  it('gives a test-mode scanner a 404 for a live key', async () => {
    const test = await t.fixture.kit.scanner({ kind: route.kind, mode: 'test' });
    await expectProblem(await call(test.id, keys.admin.headers), 404, 'SCANNER_NOT_FOUND');
  });

  it('refuses a template-restricted key, and stops a revoked or expired one', async () => {
    const s = await target();
    await expectProblem(await call(s.id, keys.restricted.headers), 403, 'API_KEY_RESTRICTED_ROUTE');
    t.fixture.kit.clock.advance(2000);
    for (const k of [keys.revoked, keys.expired])
      await expectProblem(await call(s.id, k.headers), 401, 'INVALID_API_KEY');
  });

  it('allows 60 calls an hour: the 61st is 429, and a refused call costs nothing', async () => {
    const k = await t.key(['scanning:admin']);
    const s = await target();
    for (let n = 0; n < 60; n++) expect((await call(s.id, k.headers)).status).toBe(200);
    const over = await call(s.id, k.headers);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).not.toBeNull();
    t.fixture.kit.clock.advance(3_600_000);
    expect((await call(s.id, k.headers)).status).toBe(200);
    // A 409 refunds its charge: 70 refused calls leave the hour untouched.
    const revoked = await target();
    await t.fixture.call('POST', `/scanners/${revoked.id}/revoke`);
    const k2 = await t.key(['scanning:admin']);
    for (let n = 0; n < 70; n++) {
      const res = await call(revoked.id, k2.headers);
      expect([409, 422]).toContain(res.status);
    }
    expect((await call((await target()).id, k2.headers)).status).toBe(200);
  });

  it('shares the 100 secrets a day with the setup', async () => {
    const k = await t.key(['scanning:admin']);
    const s = await target();
    const day = Math.floor(t.fixture.kit.clock.now() / 86_400_000) * 86_400_000;
    await run(t.env().DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 99)', [
      `scan-setup:secrets:${k.id}`,
      day,
    ]);
    expect((await call(s.id, k.headers)).status).toBe(200);
    expect((await call(s.id, k.headers)).status).toBe(429);
  });

  it('refuses at commit a key revoked after its authority was captured, with no secret and no row', async () => {
    const k = await t.key(['scanning:admin']);
    const s = await target();
    const row = await getConsoleScanner(t.env().DB, s.id);
    if (!row) throw new Error('scanner missing');
    const ctx = t.fixture.kit.ctx;
    const authority = {
      kind: 'api_key' as const,
      orgId: t.orgId(),
      orgAccessRevision: (await tenantOrgAccessRevision(t.env().DB, t.orgId())) ?? 0,
      keyId: k.id,
      keyOrgId: t.orgId(),
      scopes: ['scanning:admin' as const],
      scope: 'scanning:admin' as const,
      mode: 'live' as const,
    };
    await run(t.env().DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      ctx.clock.now(),
      k.id,
    ]);
    const before = await state(s.id);
    const issue =
      route.name === 'pairing'
        ? createPairing(ctx, k.id, row, 'https://wallet.test', authority)
        : replaceTerminalToken(ctx, k.id, row, authority);
    await expect(issue).rejects.toMatchObject({ status: 403 });
    expect(await state(s.id)).toEqual(before);
    expect(await t.keyAudit(s.id, route.action)).toHaveLength(0);
  });
});

describe('pairing poll by key', () => {
  it('follows only its own org and mode', async () => {
    const s = await t.scanner();
    const path = paths.pairing(s.id);
    expect((await t.send('GET', path, keys.read.headers)).status).toBe(200);
    const platform = await t.key(['scan-setup:read'], { orgId: null, kind: 'platform' });
    const foreign = await t.key(['scan-setup:read'], { orgId: keys.otherOrgId });
    for (const k of [platform, foreign])
      await expectProblem(await t.send('GET', path, k.headers), 404, 'SCANNER_NOT_FOUND');
    const test = await t.key(['scan-setup:read'], { mode: 'test' });
    await expectProblem(await t.send('GET', path, test.headers), 404, 'SCANNER_NOT_FOUND');
    const wrong = await t.key(['scans:read']);
    await expectProblem(await t.send('GET', path, wrong.headers), 403, 'MISSING_SCOPE');
  });
});

describe('review probes', () => {
  const counters = (keyId: string) =>
    all<{ key: string; count: number }>(
      t.env().DB,
      'SELECT key, count FROM counters WHERE key LIKE ?',
      [`%${keyId}`],
    );

  it('refuses a forced test-mode admin key on a test scanner with 403, and refunds', async () => {
    const test = await t.fixture.kit.scanner({ kind: 'device', mode: 'test' });
    const till = await t.fixture.kit.scanner({ kind: 'terminal', mode: 'test' });
    const before = await t.auditCount();
    await expectProblem(
      await t.send('POST', paths.pairing(test.id), keys.testAdmin.headers),
      403,
      'FORBIDDEN',
    );
    await expectProblem(
      await t.send('POST', paths.token(till.id), keys.testAdmin.headers),
      403,
      'FORBIDDEN',
    );
    expect(await t.auditCount()).toBe(before);
    expect((await counters(keys.testAdmin.id)).every((r: { count: number }) => r.count === 0)).toBe(
      true,
    );
  });

  it('gives a key that breaks the mint rule no code: no expiry, a long expiry, a role', async () => {
    const s = await t.scanner();
    const day = 86_400_000;
    const now = t.fixture.kit.clock.now();
    const bad = [
      await t.key(['scanning:admin'], { expiresAt: undefined as never }),
      await t.key(['scanning:admin'], { expiresAt: now + 200 * day }),
      await t.key(['scanning:admin'], { roles: ['org_admin'] }),
    ];
    const before = await state(s.id);
    for (const k of bad)
      await expectProblem(
        await t.send('POST', paths.pairing(s.id), k.headers),
        403,
        'MISSING_SCOPE',
      );
    expect(await state(s.id)).toEqual(before);
  });

  it('refuses at commit a key revoked after the route captured its authority, and refunds', async () => {
    const k = await t.key(['scanning:admin']);
    const s = await t.scanner();
    const before = await state(s.id);
    let revoked = false;
    const db = t.env().DB;
    // The first budget write follows the authority capture: revoke the key right there.
    const hook = (st: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(st, {
        get(target, prop) {
          if (prop === 'bind') return (...v: unknown[]) => hook(target.bind(...v));
          if (prop === 'first' && !revoked)
            return async (...a: unknown[]) => {
              revoked = true;
              await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                t.fixture.kit.clock.now(),
                k.id,
              ]);
              return (target.first as (...x: unknown[]) => Promise<unknown>)(...a);
            };
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    const over = {
      ...t.env(),
      DB: new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) =>
              sql.includes(RACE_COUNTER_BUMP) ? hook(target.prepare(sql)) : target.prepare(sql);
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    } as ReturnType<typeof t.env>;
    const res = await t.send('POST', paths.pairing(s.id), k.headers, undefined, undefined, over);
    expect(revoked).toBe(true);
    expect(res.status).toBe(403);
    expect(await state(s.id)).toEqual(before);
    expect(await t.keyAudit(s.id, 'scanner.pairing_create')).toHaveLength(0);
    expect((await counters(k.id)).every((r: { count: number }) => r.count === 0)).toBe(true);
  });

  it('holds an 80-call burst to the budget: at most 60 calls, and refused ones are refunded', async () => {
    const k = await t.key(['scanning:admin']);
    const s = await t.scanner();
    const res = await Promise.all(
      Array.from({ length: 80 }, () => t.send('POST', paths.pairing(s.id), k.headers)),
    );
    const ok = res.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(60);
    const calls = (await counters(k.id)).find((r) => r.key.startsWith('scan-cred:calls'));
    expect(calls?.count).toBeLessThanOrEqual(60);
    expect(calls?.count).toBe(ok);
  });
});
