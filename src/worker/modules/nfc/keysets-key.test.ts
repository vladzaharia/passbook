import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { keysetRequestBody } from './keyset-idem.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
const output: string[] = [];
beforeAll(async () => {
  f = await keysetFixture();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      output.push(a.map(String).join(' '));
    });
});

const DAY = 86_400_000;
const HEX = /^[0-9a-f]{32}$/;
const env = () => f.kit.env;
type T = Awaited<ReturnType<typeof f.org>>;
const key = (t: T, scopes = ['nfc:keys'], over: Parameters<typeof makeApiKey>[1] = {}) =>
  makeApiKey(f.kit.fx, {
    orgId: t.org.id,
    scopes,
    mode: 'live',
    expiresAt: f.kit.clock.now() + 30 * DAY,
    ...over,
  });
const call = (
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
  idem?: string,
) =>
  f.call(
    { ...headers, 'cf-connecting-ip': '203.0.113.7', ...(idem ? { 'idempotency-key': idem } : {}) },
    method,
    path,
    body,
  );
const body = async (r: Response) => (await r.json()) as Record<string, any>;
let n = 0;
const create = (t: T, headers: Record<string, string>, over: object = {}, idem?: string) =>
  call(
    headers,
    'POST',
    `/keysets?orgId=${t.org.id}`,
    { name: `Badges ${++n}`, generate: true, ...over },
    idem,
  );
const writes = async (id: string) =>
  (
    await all<{ count: number }>(env().DB, 'SELECT count FROM counters WHERE key = ?', [
      `nfc-keys:writes:${id}`,
    ])
  )[0]?.count ?? 0;

describe('keysets by nfc:keys key', () => {
  it('shows generated keys once; a replay, the store, audit, logs and reads hold none', async () => {
    const t = await f.org();
    const k = await key(t);
    const first1 = await create(t, k.headers, { name: 'Once' }, 'ks-once');
    const replay = await create(t, k.headers, { name: 'Once' }, 'ks-once');
    expect(first1.status).toBe(201);
    const one = await body(first1.clone());
    expect(one.keys.metaKey).toMatch(HEX);
    expect(one.keys.fileKey).toMatch(HEX);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const again = await body(replay.clone());
    expect(again.id).toBe(one.id);
    expect(again.keys).toBeNull();
    for (const r of [first1, replay]) expect(r.headers.get('cache-control')).toMatch(/no-store/);
    const list = await (await call(k.headers, 'GET', `/keysets?orgId=${t.org.id}`)).text();
    const places = JSON.stringify({
      idem: await all(env().DB, 'SELECT body, request_hash FROM idempotent_requests'),
      audit: await all(env().DB, 'SELECT * FROM audit_log'),
      keys: await all(env().DB, 'SELECT * FROM nfc_tag_keys'),
      keyset: await first(env().DB, 'SELECT * FROM nfc_tag_keysets WHERE id = ?', [one.id]),
      logs: output.join('\n'),
      list,
    });
    for (const v of [one.keys.metaKey, one.keys.fileKey]) expect(places.includes(v)).toBe(false);
    const rows = await all<{ actor_type: string; actor_id: string; ip_prefix: string }>(
      env().DB,
      "SELECT actor_type, actor_id, ip_prefix FROM audit_log WHERE action = 'tag_keyset.create' AND target_id = ?",
      [one.id],
    );
    expect(rows).toEqual([{ actor_type: 'api_key', actor_id: k.id, ip_prefix: '203.0.113.0/24' }]);
    expect(
      await first(env().DB, 'SELECT created_by FROM nfc_tag_keysets WHERE id = ?', [one.id]),
    ).toEqual({ created_by: k.id });
    // Another key sending the same header runs fresh; another body with the same key is refused.
    const other = await key(t);
    expect((await create(t, other.headers, { name: 'Once two' }, 'ks-once')).status).toBe(201);
    await expectProblem(
      await create(t, k.headers, { name: 'Different' }, 'ks-once'),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('never echoes typed-in keys, and the request hash is over their HMACs', async () => {
    const t = await f.org();
    const k = await key(t);
    const meta = 'a1'.repeat(16);
    const file = 'b2'.repeat(16);
    const made = await create(
      t,
      k.headers,
      { generate: undefined, metaKey: meta, fileKey: file },
      'ks-typed',
    );
    expect(made.status).toBe(201);
    expect((await body(made)).keys).toBeNull();
    const places = JSON.stringify({
      idem: await all(env().DB, 'SELECT * FROM idempotent_requests'),
      audit: await all(env().DB, 'SELECT * FROM audit_log'),
      logs: output.join('\n'),
    });
    expect(places.includes(meta) || places.includes(file)).toBe(false);
    const hashed = await keysetRequestBody(env(), { name: 'x', metaKey: meta, fileKey: file });
    expect(JSON.stringify(hashed).includes(meta)).toBe(false);
    expect(hashed.metaKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates, retires, revokes and disables; step-up is never asked of a key', async () => {
    const t = await f.org();
    const k = await key(t);
    const made = await body(await create(t, k.headers));
    const rotated = await call(
      k.headers,
      'POST',
      `/keysets/${made.id}/rotate`,
      { generate: true },
      'ks-rot',
    );
    expect(rotated.status).toBe(200);
    expect((await body(rotated.clone())).keys.metaKey).toMatch(HEX);
    const replay = await call(
      k.headers,
      'POST',
      `/keysets/${made.id}/rotate`,
      { generate: true },
      'ks-rot',
    );
    expect((await body(replay)).keys).toBeNull();
    const spent = await writes(k.id);
    await expectProblem(
      await call(k.headers, 'POST', `/keysets/${made.id}/rotate`, { generate: true }),
      409,
      'KEYSET_RETIRE_FIRST',
    );
    expect(await writes(k.id)).toBe(spent);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/keys/1/retire`)).status).toBe(200);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/keys/2/revoke`)).status).toBe(200);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/disable`)).status).toBe(200);
    const actions = await all<{ action: string; actor_type: string }>(
      env().DB,
      "SELECT action, actor_type FROM audit_log WHERE target_id = ? AND action LIKE 'tag_keyset.%'",
      [made.id],
    );
    expect(actions.every((a) => a.actor_type === 'api_key')).toBe(true);
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it('re-enrols and imports; a dry run is free', async () => {
    const t = await f.org();
    const k = await key(t);
    const a = await body(await create(t, k.headers));
    const b = await body(await create(t, k.headers));
    const moved = await call(k.headers, 'POST', `/keysets/${a.id}/reenrol`, { toKeysetId: b.id });
    expect(moved.status).toBe(200);
    const perTag = await body(
      await call(k.headers, 'POST', `/keysets?orgId=${t.org.id}`, {
        name: 'Supplier',
        perTag: true,
        metaKey: 'c3'.repeat(16),
      }),
    );
    const before = await writes(k.id);
    const dry = await call(k.headers, 'POST', `/keysets/${perTag.id}/import`, {
      csv: 'uid,key\n',
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(await writes(k.id)).toBe(before);
    const add = await call(k.headers, 'POST', `/keysets/${perTag.id}/import`, {
      csv: 'uid,key\n',
      dryRun: false,
    });
    expect(add.status).toBe(200);
    expect(await writes(k.id)).toBe(before + 1);
  });
});

describe('keysets: who may call', () => {
  it('refuses another scope, with the crossed scopes both ways', async () => {
    const t = await f.org();
    const made = await body(await create(t, (await key(t)).headers));
    for (const scope of ['scanning:admin', 'scanning:write', 'scan-setup:read']) {
      const k = await key(t, [scope]);
      await expectProblem(
        await call(k.headers, 'GET', `/keysets?orgId=${t.org.id}`),
        403,
        'MISSING_SCOPE',
      );
      await expectProblem(await create(t, k.headers), 403, 'MISSING_SCOPE');
      await expectProblem(
        await call(k.headers, 'POST', `/keysets/${made.id}/disable`),
        403,
        'MISSING_SCOPE',
      );
    }
  });

  it('gives a platform key, another org, a forced test key and a bad key nothing, writing nothing', async () => {
    const t = await f.org();
    const made = await body(await create(t, (await key(t)).headers));
    const other = await makeOrg(f.kit.fx);
    const [audits, keysets] = [
      (
        await first<{ n: number }>(
          env().DB,
          "SELECT count(*) AS n FROM audit_log WHERE action LIKE 'tag_keyset.%'",
        )
      )?.n,
      (await first<{ n: number }>(env().DB, 'SELECT count(*) AS n FROM nfc_tag_keysets'))?.n,
    ];
    const platform = await key(t, ['nfc:keys'], { orgId: null, kind: 'platform' });
    const foreign = await makeApiKey(f.kit.fx, {
      orgId: other.id,
      scopes: ['nfc:keys'],
      mode: 'live',
      expiresAt: f.kit.clock.now() + DAY,
    });
    const test = await key(t, ['nfc:keys'], { mode: 'test' });
    for (const k of [platform, foreign, test]) {
      await expectProblem(
        await call(k.headers, 'GET', `/keysets?orgId=${t.org.id}`),
        404,
        'ORG_NOT_FOUND',
      );
      await expectProblem(await create(t, k.headers), 404, 'ORG_NOT_FOUND');
      await expectProblem(
        await call(k.headers, 'POST', `/keysets/${made.id}/disable`),
        404,
        'KEYSET_NOT_FOUND',
      );
    }
    await expectProblem(
      await call((await key(t)).headers, 'GET', `/keysets?orgId=${other.id}`),
      404,
      'ORG_NOT_FOUND',
    );
    await expectProblem(
      await create(t, (await key(t, ['nfc:keys'], { passStyles: ['generic'] })).headers),
      403,
      'API_KEY_RESTRICTED_ROUTE',
    );
    // The mint rule at use: no expiry, or a role, and the scope does not count.
    for (const bad of [
      await key(t, ['nfc:keys'], { expiresAt: undefined as never }),
      await key(t, ['nfc:keys'], { roles: ['org_admin'] }),
    ])
      await expectProblem(await create(t, bad.headers), 403, 'MISSING_SCOPE');
    const gone = await key(t);
    await run(env().DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      f.kit.clock.now(),
      gone.id,
    ]);
    await expectProblem(await create(t, gone.headers), 401, 'INVALID_API_KEY');
    expect([
      (
        await first<{ n: number }>(
          env().DB,
          "SELECT count(*) AS n FROM audit_log WHERE action LIKE 'tag_keyset.%'",
        )
      )?.n,
      (await first<{ n: number }>(env().DB, 'SELECT count(*) AS n FROM nfc_tag_keysets'))?.n,
    ]).toEqual([audits, keysets]);
  });

  it('allows 30 keyset writes a day; a refused write costs nothing', async () => {
    const t = await f.org();
    const k = await key(t);
    const made = await body(await create(t, k.headers));
    const day = Math.floor(f.kit.clock.now() / DAY) * DAY;
    await run(env().DB, 'UPDATE counters SET count = 28 WHERE key = ? AND window_start = ?', [
      `nfc-keys:writes:${k.id}`,
      day,
    ]);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/keys/1/retire`)).status).toBe(409);
    expect(await writes(k.id)).toBe(28);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/disable`)).status).toBe(200);
    expect((await call(k.headers, 'POST', `/keysets/${made.id}/disable`)).status).toBe(200);
    const over = await call(k.headers, 'POST', `/keysets/${made.id}/disable`);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(3600);
    expect(await writes(k.id)).toBe(30);
  });
});
