import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeApiKey, makeOrg, makeScanner } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { beforeBatch } from './repo-action-template-read-race-test-fixtures.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let app: ReturnType<typeof createApp>;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth('https://wallet.test');
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({
    stores: {
      ...fake.stores,
      scanners: createScannerStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  templateId = await kit.scanTemplate('Till', {
    actions: [
      { id: 'check_in', label: 'Check in', kind: 'check_in' },
      { id: 'vip', label: 'VIP', kind: 'check_in', minRole: 'manager' },
    ],
  });
});

const call = (headers: Record<string, string>, path: string, body: unknown = {}) =>
  Promise.resolve(
    app.request(
      `https://wallet.test/api/v1/scan${path}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      kit.env,
    ),
  );
const bodyOf = async (res: Response) => (await res.json()) as { code?: string };
const read = (passId: string) => ({
  idempotencyKey: key(),
  input: { passId, method: 'manual' as const },
  clientTs: kit.clock.now(),
});
const request = (passId: string, over: Record<string, unknown> = {}) => ({
  ...read(passId),
  actionId: 'check_in',
  ...over,
});
const problemOf = async (res: Response) => {
  const { requestId: _requestId, ...rest } = (await res.json()) as Record<string, unknown>;
  return rest;
};

async function till(options: {
  scopes?: string[];
  orgId?: string | null;
  mode?: 'live' | 'test';
  terminal?: Parameters<typeof kit.scanner>[0];
}) {
  const terminal = await kit.scanner({
    kind: 'terminal',
    templateIds: [templateId],
    settings: { flow: 'auto', letInAgain: 'anyone' },
    ...options.terminal,
  });
  const apiKey = await makeApiKey(kit.fx, {
    orgId: options.orgId === undefined ? kit.org.id : options.orgId,
    scopes: options.scopes ?? ['scans:write'],
    mode: options.mode ?? 'live',
  });
  const headers: Record<string, string> = {
    ...apiKey.headers,
    'x-passbook-device': terminal.id,
  };
  return { terminal, apiKey, headers };
}

describe('a scans:write key acting as a terminal', () => {
  it('scans, reads and undoes as the terminal, and the ledger names the key', async () => {
    const t = await till({});
    const pass = await kit.scanPass(templateId);
    const resolved = await call(t.headers, '/resolve', read(pass.id));
    expect(resolved.status).toBe(200);
    const res = await call(t.headers, '/actions', request(pass.id));
    expect(res.status).toBe(200);
    const outcome = ScanOutcomeSchema.parse(await res.json());
    expect(outcome.kind).toBe('ok');
    const row = await first<{ actor_key: string; actor_type: string }>(
      kit.env.DB,
      'SELECT actor_key, actor_type FROM scans WHERE id = ?',
      [outcome.scanId],
    );
    expect(row).toEqual({ actor_key: `s:${t.terminal.id}`, actor_type: 'scanner' });
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(JSON.parse(event?.data ?? '{}')).toMatchObject({
      scannerId: t.terminal.id,
      apiKeyId: t.apiKey.id,
    });
    const undone = await call(t.headers, `/scans/${outcome.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
  });

  it('is a Desk at most: a manager-only action is refused', async () => {
    const t = await till({ terminal: { settings: { roleWithoutSignIn: 'desk' } } });
    const pass = await kit.scanPass(templateId);
    const res = await call(t.headers, '/actions', request(pass.id, { actionId: 'vip' }));
    expect(res.status).toBe(200);
    expect(ScanOutcomeSchema.parse(await res.json()).kind).not.toBe('ok');
    expect(await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toBeNull();
  });

  it('refuses approvals and overrides', async () => {
    const t = await till({});
    const pass = await kit.scanPass(templateId);
    const manager = await kit.staff('manager');
    const approved = await call(
      t.headers,
      '/actions',
      request(pass.id, { approval: { staffId: manager.id, pin: manager.pin } }),
    );
    expect(approved.status).toBe(403);
    expect((await bodyOf(approved)).code).toBe('API_KEY_NO_APPROVAL');
    const override = await call(t.headers, '/actions', request(pass.id, { overrideOf: key() }));
    expect(override.status).toBe(403);
    expect((await bodyOf(override)).code).toBe('API_KEY_NO_APPROVAL');
    const undo = await call(t.headers, `/scans/${key()}/undo`, {
      idempotencyKey: key(),
      approval: { staffId: manager.id, pin: manager.pin },
    });
    expect((await bodyOf(undo)).code).toBe('API_KEY_NO_APPROVAL');
    expect(await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toBeNull();
  });

  it('refuses a platform key, a missing scope, a missing header and other routes', async () => {
    const platform = await till({ orgId: null });
    const pass = await kit.scanPass(templateId);
    const noOrg = await call(platform.headers, '/actions', request(pass.id));
    expect([noOrg.status, (await bodyOf(noOrg)).code]).toEqual([403, 'API_KEY_ORG_REQUIRED']);
    const noScope = await till({ scopes: ['scans:read', 'passes:write'] });
    const missing = await call(noScope.headers, '/actions', request(pass.id));
    expect([missing.status, (await bodyOf(missing)).code]).toEqual([403, 'MISSING_SCOPE']);
    const t = await till({});
    const noHeader = await call(t.apiKey.headers, '/actions', request(pass.id));
    expect([noHeader.status, (await bodyOf(noHeader)).code]).toEqual([422, 'DEVICE_REQUIRED']);
    for (const path of ['/device', '/session', '/staff']) {
      const res = await call(t.headers, path, {});
      expect([path, res.status, (await bodyOf(res)).code]).toEqual([path, 403, 'API_KEY_ROUTE']);
    }
    const get = await app.request(
      'https://wallet.test/api/v1/scan/session',
      { headers: t.headers },
      kit.env,
    );
    expect((await bodyOf(get)).code).toBe('API_KEY_ROUTE');
    expect(await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toBeNull();
  });

  it('cannot cross org or mode with the device header', async () => {
    const t = await till({});
    const pass = await kit.scanPass(templateId);
    const other = await makeOrg(kit.fx);
    const foreign = await makeScanner(kit.fx, { orgId: other.id, kind: 'terminal' });
    const testMode = await kit.scanner({ kind: 'terminal', mode: 'test' });
    const unknown = await call(
      { ...t.headers, 'x-passbook-device': key() },
      '/actions',
      request(pass.id),
    );
    const seen: unknown[] = [];
    for (const id of [foreign.id, testMode.id]) {
      const res = await call(
        { ...t.headers, 'x-passbook-device': id },
        '/actions',
        request(pass.id),
      );
      expect(res.status).toBe(404);
      seen.push(await problemOf(res));
    }
    const expected = await problemOf(unknown);
    expect(seen).toEqual([expected, expected]);
    // A test-mode key cannot drive a live terminal either.
    const testKey = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['scans:write'],
      mode: 'test',
    });
    const cross = await call(
      { ...testKey.headers, 'x-passbook-device': t.terminal.id },
      '/actions',
      request(pass.id),
    );
    expect(cross.status).toBe(404);
    expect(await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toBeNull();
  });

  it('acts only as a live terminal', async () => {
    const pass = await kit.scanPass(templateId);
    for (const terminal of [{ kind: 'device' as const }, { kind: 'display' as const }]) {
      const t = await till({ terminal });
      const res = await call(t.headers, '/actions', request(pass.id));
      expect([terminal.kind, res.status, (await bodyOf(res)).code]).toEqual([
        terminal.kind,
        403,
        'TERMINAL_ONLY',
      ]);
    }
    const revoked = await till({ terminal: { revoked: true } });
    expect((await call(revoked.headers, '/actions', request(pass.id))).status).toBe(404);
    expect(await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id])).toBeNull();
  });

  it('refuses a revoked key before and during the request', async () => {
    const pass = await kit.scanPass(templateId);
    const before = await till({});
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      before.apiKey.id,
    ]);
    const gone = await call(before.headers, '/actions', request(pass.id));
    expect([gone.status, (await bodyOf(gone)).code]).toEqual([401, 'INVALID_API_KEY']);
    for (const marker of ['INSERT INTO scans', 'INSERT INTO scan_gates']) {
      const t = await till({});
      const real = kit.env.DB;
      const hook = beforeBatch(real, marker, (db) =>
        run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [kit.clock.now(), t.apiKey.id]),
      );
      Object.assign(kit.env, { DB: hook.db });
      let res: Response;
      try {
        res = await call(t.headers, '/actions', request(pass.id));
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(hook.fired(), marker).toBe(true);
      expect([marker, res.status, (await bodyOf(res)).code]).toEqual([
        marker,
        401,
        'INVALID_API_KEY',
      ]);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
    }
  });
});
