import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fakeRateLimiter,
  makeOrg,
  makeSession,
  makeUser,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from '../scan/auth-store.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { makeSandbox, startAndSettle } from './sandbox-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  Object.assign(kit.env, {
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
  });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

/** A sandbox made as the portal makes it. */
async function sandbox() {
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  const headers = { ...session.headers, origin: ORIGIN };
  const create = () =>
    startAndSettle(send, headers, 'POST', '/developer/sandbox', { turnstileToken: 'ok' });
  const made = await makeSandbox(send, headers);
  if (!made.key) throw new Error('A new sandbox mints its key.');
  const terminals = () =>
    all<{ id: string; kind: string; mode: string; token_hash: string | null }>(
      kit.env.DB,
      'SELECT id, kind, mode, token_hash FROM scanners WHERE org_id = ? AND name = ?',
      [made.orgId, SANDBOX_TERMINAL_NAME],
    );
  const [terminal] = await terminals();
  if (!terminal) throw new Error('A sandbox has a terminal.');
  const key = { authorization: `Bearer ${made.key.secret}` };
  const pass = async () => {
    const detail = await send('GET', `/templates/${made.templateId}`, key);
    const sample = ((await detail.json()) as { manifest: { sample?: Record<string, unknown> } })
      .manifest.sample;
    const res = await send('POST', '/passes', key, {
      templateId: made.templateId,
      input: { ...(sample ?? {}), startsAt: at(-1), endsAt: at(2) },
      holderEmail: 'holder@example.com',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const issued = (await res.json()) as { id: string };
    return issued;
  };
  return { made, key, terminal, terminals, pass, create };
}

/** An ISO time `hours` from the test clock, written with an offset so it shows as the same wall clock. */
const at = (hours: number) =>
  new Date(kit.clock.now() + hours * 3_600_000).toISOString().replace('Z', '+00:00');

const call = (headers: Record<string, string>, path: string, body: unknown) =>
  send('POST', `/scan${path}`, headers, body);
const read = (passId: string) => ({
  idempotencyKey: kit.f.ids.id(),
  input: { passId, method: 'manual' },
  clientTs: kit.clock.now(),
});
const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe('the sandbox test terminal', () => {
  it('is made once, in Test, never paired; a retry adds no second', async () => {
    const s = await sandbox();
    expect(s.terminal).toMatchObject({ kind: 'terminal', mode: 'test', token_hash: null });
    expect((await s.create()).status).toBe('succeeded');
    expect(await s.terminals()).toHaveLength(1);
  });

  it('lets the sandbox key resolve, act and undo as it, without scans:write', async () => {
    const s = await sandbox();
    const stored = await first<{ scopes: string }>(
      kit.env.DB,
      'SELECT scopes FROM api_keys WHERE id = ?',
      [s.made.key?.id],
    );
    expect(JSON.parse(stored?.scopes ?? '[]')).not.toContain('scans:write');
    const headers = { ...s.key, 'x-passbook-device': s.terminal.id };
    const pass = await s.pass();
    const seen = await call(headers, '/resolve', read(pass.id));
    expect(seen.status).toBe(200);
    const acted = await call(headers, '/actions', { ...read(pass.id), actionId: 'auto' });
    expect(acted.status).toBe(200);
    const outcome = (await acted.json()) as { kind: string; scanId: string };
    expect(outcome.kind).toBe('ok');
    const undone = await call(headers, `/scans/${outcome.scanId}/undo`, {
      idempotencyKey: kit.f.ids.id(),
    });
    expect(undone.status).toBe(200);
  });

  it('is the only terminal a sandbox key reaches, and no other key reaches it', async () => {
    const a = await sandbox();
    const b = await sandbox();
    const pass = await a.pass();
    const other = (headers: Record<string, string>, device?: string) =>
      call(
        { ...headers, ...(device ? { 'x-passbook-device': device } : {}) },
        '/resolve',
        read(pass.id),
      );
    // The other sandbox's key and a missing header.
    const cross = await other(b.key, a.terminal.id);
    expect([cross.status, await codeOf(cross)]).toEqual([404, 'TERMINAL_NOT_FOUND']);
    // The alias names the caller's own sandbox terminal, never another's.
    const alias = await other(b.key, 'sandbox');
    expect(alias.status).toBe(200);
    const none = await other(a.key);
    expect([none.status, await codeOf(none)]).toEqual([422, 'DEVICE_REQUIRED']);
    // A scanner the sandbox row does not name is no way in, whatever it is called.
    await run(kit.env.DB, 'UPDATE developer_sandboxes SET terminal_id = NULL WHERE org_id = ?', [
      a.made.orgId,
    ]);
    const unnamed = await other(a.key, a.terminal.id);
    expect([unnamed.status, await codeOf(unnamed)]).toEqual([404, 'TERMINAL_NOT_FOUND']);
  });

  it('gives a key of an ordinary organization no terminal without scans:write', async () => {
    const s = await sandbox();
    const org = await makeOrg(kit.f);
    const owner = await kit.member(org.id, ['org_admin']);
    const prefix = kit.f.ids.token(6);
    const secret = `wlt_${prefix}_${kit.f.ids.token()}`;
    await run(
      kit.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at, kind)
       VALUES (?, ?, 'K', ?, ?, ?, 'test', ?, ?, 'service')`,
      [
        kit.f.ids.id(),
        org.id,
        prefix,
        await sha256Hex(secret),
        JSON.stringify(['passes:write', 'passes:read']),
        owner.userId,
        kit.clock.now(),
      ],
    );
    const res = await call(
      { authorization: `Bearer ${secret}`, 'x-passbook-device': s.terminal.id },
      '/resolve',
      read(kit.f.ids.id()),
    );
    expect([res.status, await codeOf(res)]).toEqual([403, 'MISSING_SCOPE']);
  });

  it('stops with the key: a revoked key is refused', async () => {
    const s = await sandbox();
    const pass = await s.pass();
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      s.made.key?.id,
    ]);
    const res = await call(
      { ...s.key, 'x-passbook-device': s.terminal.id },
      '/resolve',
      read(pass.id),
    );
    expect(res.status).toBe(401);
  });

  it('is made on first use for a sandbox that has none, once under a race', async () => {
    const s = await sandbox();
    // A sandbox from before the terminal existed.
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = 1 WHERE id = ?', [s.terminal.id]);
    await run(kit.env.DB, 'UPDATE developer_sandboxes SET terminal_id = NULL WHERE org_id = ?', [
      s.made.orgId,
    ]);
    const pass = await s.pass();
    const via = () => call({ ...s.key, 'x-passbook-device': 'sandbox' }, '/resolve', read(pass.id));
    const answers = await Promise.all([via(), via()]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    const open = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM scanners WHERE org_id = ? AND name = ? AND revoked_at IS NULL',
      [s.made.orgId, SANDBOX_TERMINAL_NAME],
    );
    expect(open).toHaveLength(1);
    const named = await first<{ terminal_id: string }>(
      kit.env.DB,
      'SELECT terminal_id FROM developer_sandboxes WHERE org_id = ?',
      [s.made.orgId],
    );
    expect(named?.terminal_id).toBe(open[0]?.id);
  });

  it('replaces a terminal that has expired, and the key scans as the new one', async () => {
    const s = await sandbox();
    await run(kit.env.DB, 'UPDATE scanners SET expires_at = ? WHERE id = ?', [
      kit.clock.now() - 1,
      s.terminal.id,
    ]);
    const pass = await s.pass();
    const res = await call({ ...s.key, 'x-passbook-device': 'sandbox' }, '/resolve', read(pass.id));
    expect(res.status).toBe(200);
    const [fresh] = await s.terminals().then((all) => all.filter((t) => t.id !== s.terminal.id));
    expect(fresh).toBeDefined();
    const old = await first<{ revoked_at: number | null }>(
      kit.env.DB,
      'SELECT revoked_at FROM scanners WHERE id = ?',
      [s.terminal.id],
    );
    expect(old?.revoked_at).not.toBeNull();
  });

  it('keeps a sandbox key off the terminal once it loses passes:write or the sandbox closes', async () => {
    const s = await sandbox();
    const pass = await s.pass();
    const headers = { ...s.key, 'x-passbook-device': s.terminal.id };
    expect((await call(headers, '/resolve', read(pass.id))).status).toBe(200);
    await run(
      kit.env.DB,
      'UPDATE developer_sandboxes SET closed_at = 1, close_reason = ? WHERE org_id = ?',
      ['user', s.made.orgId],
    );
    expect((await call(headers, '/actions', { ...read(pass.id), actionId: 'auto' })).status).toBe(
      404,
    );
  });

  it('refuses a sandbox key that no longer holds passes:write', async () => {
    const s = await sandbox();
    const pass = await s.pass();
    const headers = { ...s.key, 'x-passbook-device': s.terminal.id };
    expect((await call(headers, '/resolve', read(pass.id))).status).toBe(200);
    await withoutTrigger(kit.env.DB, 'api_keys_identity_immutable', () =>
      run(
        kit.env.DB,
        `UPDATE api_keys SET scopes = (SELECT json_group_array(j.value) FROM json_each(api_keys.scopes) j
           WHERE j.value <> 'passes:write') WHERE id = ?`,
        [s.made.key?.id],
      ),
    );
    const res = await call(headers, '/resolve', read(pass.id));
    expect([res.status, await codeOf(res)]).toEqual([403, 'MISSING_SCOPE']);
  });

  it('answers a rate-limited first use with 429, not 404', async () => {
    const s = await sandbox();
    const pass = await s.pass();
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = 1 WHERE id = ?', [s.terminal.id]);
    await run(kit.env.DB, 'UPDATE developer_sandboxes SET terminal_id = NULL WHERE org_id = ?', [
      s.made.orgId,
    ]);
    const real = kit.env.RL_SCAN_PAIR;
    Object.assign(kit.env, { RL_SCAN_PAIR: fakeRateLimiter({ limit: 0 }) });
    try {
      const res = await call(
        { ...s.key, 'x-passbook-device': 'sandbox' },
        '/resolve',
        read(pass.id),
      );
      expect([res.status, await codeOf(res)]).toEqual([429, 'RATE_LIMITED']);
    } finally {
      Object.assign(kit.env, { RL_SCAN_PAIR: real });
    }
    const again = await call(
      { ...s.key, 'x-passbook-device': 'sandbox' },
      '/resolve',
      read(pass.id),
    );
    expect(again.status).toBe(200);
  });
});
