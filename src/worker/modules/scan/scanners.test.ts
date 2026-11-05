import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanEvent,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { overrideDeps } from '../passes/deps.ts';
import { createScannerStore } from './auth-store.ts';

const ORIGIN = 'https://wallet.test';
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let templateId: string;
let ipN = 0;
let userId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv({ RL_SCAN_PAIR: fakeRateLimiter({ limit: 1000 }) } as never);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  const stores = { ...fake.stores, scanners: createScannerStore(env, clock) };
  app = createApp({ stores, clock });
  await run(env.DB, 'DELETE FROM audit_log');
  await run(env.DB, 'DELETE FROM counters');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  const t = makeTemplate({ id: f.ids.id(), orgId });
  await persistTemplate(f, t.resolved);
  templateId = t.resolved.id;
  ipN++;
});

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const consoleCall = (method: string, path: string, body?: unknown, headers = admin()) =>
  send(method, `/api/v1/scanners${path}`, headers, body);
const device = (
  agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1 Version/17 Mobile',
) => ({
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'user-agent': agent,
  'cf-connecting-ip': `203.0.${ipN}.9`,
});
const pairCall = (path: string, code: string, headers = device()) =>
  send('POST', `/api/v1/scan/pair${path}`, headers, { code });

interface Created {
  id: string;
  status: string;
  mode: string;
  pairing: { code: string; url: string; expiresAt: number } | null;
}
async function create(over: Record<string, unknown> = {}, headers = admin()) {
  clock.advance(1);
  const res = await consoleCall(
    'POST',
    '',
    {
      orgId,
      name: `Door ${f.ids.token(3)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'Europe/Berlin',
      ...over,
    },
    headers,
  );
  return { res, body: (await res.clone().json()) as Created };
}
const problem = async (res: Response) => {
  const { requestId: _drop, ...rest } = (await res.json()) as Record<string, unknown>;
  return rest;
};
const cookieOf = (res: Response) => {
  const raw = res.headers.get('set-cookie') ?? '';
  return { raw, token: /__Host-wallet_scan=([^;]+)/.exec(raw)?.[1] ?? '' };
};
const auditActions = async () =>
  (await all<{ action: string }>(env.DB, 'SELECT action FROM audit_log ORDER BY id')).map(
    (r) => r.action,
  );

describe('create and list', () => {
  it('creates a device with a pairing code and no token', async () => {
    const { res, body } = await create();
    expect(res.status).toBe(201);
    expect(body.status).toBe('not_paired');
    expect(body.mode).toBe('live');
    expect(body.pairing?.code).toMatch(CODE);
    expect(body.pairing?.url).toBe(`${ORIGIN}/scan#pair=${body.pairing?.code}`);
    expect(body.pairing?.expiresAt).toBe(clock.now() + 10 * 60_000);
    const row = await first<{ pair_code_hash: string; token_hash: string | null }>(
      env.DB,
      'SELECT pair_code_hash, token_hash FROM scanners WHERE id = ?',
      [body.id],
    );
    expect(row?.token_hash).toBeNull();
    expect(row?.pair_code_hash).not.toContain(body.pairing?.code);
  });

  it('a terminal gets no pairing; its token is shown once and replaced by the next', async () => {
    const { body } = await create({ kind: 'terminal', name: 'Till 1' });
    expect(body.pairing).toBeNull();
    const first1 = (await (await consoleCall('POST', `/${body.id}/token`)).json()) as {
      token: string;
      expiresAt: number;
    };
    expect(first1.token).toMatch(/^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(first1.expiresAt).toBe(clock.now() + 365 * 86_400_000);
    const second = (await (await consoleCall('POST', `/${body.id}/token`)).json()) as {
      token: string;
    };
    const store = createScannerStore(env, clock);
    expect(await store.resolve(first1.token, 'bearer')).toBeNull();
    expect((await store.resolve(second.token, 'bearer'))?.scannerId).toBe(body.id);
    const get = (await (await consoleCall('GET', `/${body.id}`)).json()) as Created;
    expect(JSON.stringify(get)).not.toContain(second.token);
  });

  it('a device has no token route', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/token`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCANNER_NOT_TERMINAL');
  });

  it('lists by mode and org, newest first, and pages', async () => {
    const other = await makeOrg(f);
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    await create({ name: 'T', accepts: { templateIds: [templateId] } }, admin('test'));
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, o.resolved);
    await create({ orgId: other.id, name: 'Other', accepts: { templateIds: [o.resolved.id] } });
    const page = async (query: string, headers = admin()) =>
      (await (await consoleCall('GET', query, undefined, headers)).json()) as {
        items: { id: string; name: string }[];
        nextCursor: string | null;
      };
    const live = await page(`?orgId=${orgId}`);
    expect(live.items.map((s) => s.name)).toEqual(['B', 'A']);
    expect((await page(`?orgId=${orgId}`, admin('test'))).items.map((s) => s.name)).toEqual(['T']);
    const first1 = await page(`?orgId=${orgId}&limit=1`);
    expect(first1.items.map((s) => s.id)).toEqual([b.body.id]);
    expect(first1.nextCursor).toBe(b.body.id);
    expect((await page(`?orgId=${orgId}&limit=1&cursor=${first1.nextCursor}`)).items[0]?.id).toBe(
      a.body.id,
    );
    expect((await page(`?orgId=${orgId}&status=paired`)).items).toEqual([]);
    expect((await page(`?orgId=${orgId}&q=b`)).items.map((s) => s.name)).toEqual(['B']);
  });

  it("another org's template or event is a 404; another mode's event is 422 SCAN_MODE_MISMATCH", async () => {
    const other = await makeOrg(f);
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, o.resolved);
    expect((await create({ accepts: { templateIds: [o.resolved.id] } })).res.status).toBe(404);
    const foreign = await makeScanEvent(f, { orgId: other.id, templateIds: [o.resolved.id] });
    expect((await create({ accepts: { eventId: foreign.id } })).res.status).toBe(404);
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const { res } = await create({ accepts: { eventId: testEvent.id } });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_MODE_MISMATCH');
    const { res: ok, body } = await create({
      accepts: { eventId: (await makeScanEvent(f, { orgId, templateIds: [templateId] })).id },
    });
    expect(ok.status).toBe(201);
    expect(body.id).toBeTruthy();
  });

  it('patch with another org template is a 404; a duplicate name is a 409', async () => {
    const other = await makeOrg(f);
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, o.resolved);
    const { body } = await create({ name: 'Main' });
    expect(
      (await consoleCall('PATCH', `/${body.id}`, { accepts: { templateIds: [o.resolved.id] } }))
        .status,
    ).toBe(404);
    expect((await create({ name: 'main' })).res.status).toBe(409);
    const renamed = await consoleCall('PATCH', `/${body.id}`, {
      name: 'Back door',
      settings: { flow: 'choose' },
    });
    expect(renamed.status).toBe(200);
    const dto = (await renamed.json()) as {
      name: string;
      settings: { flow: string; lookup: boolean };
    };
    expect(dto.name).toBe('Back door');
    expect(dto.settings).toMatchObject({ flow: 'choose', lookup: true });
  });

  it('needs an admin', async () => {
    expect((await consoleCall('GET', '', undefined, fake.user())).status).toBe(403);
    expect((await consoleCall('GET', '', undefined, {})).status).toBe(401);
  });
});

describe('pairing', () => {
  it('pairs a browser end to end: preview, pair, cookie, session, poll', async () => {
    const { body } = await create({ name: 'Front door' });
    const code = body.pairing?.code ?? '';
    const preview = await pairCall('/preview', code);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      scannerName: 'Front door',
      orgName: 'Test Org',
      mode: 'live',
    });
    expect(cookieOf(preview).token).toBe('');
    const poll = async () =>
      (await (await consoleCall('GET', `/${body.id}/pairing`)).json()) as {
        state: string;
        device: { label: string } | null;
      };
    expect((await poll()).state).toBe('waiting');
    // Typed with a space, in lower case and with Crockford's look-alikes.
    const typed = `${code.slice(0, 5).toLowerCase()} ${code.slice(5)}`;
    const paired = await pairCall('', typed);
    expect(paired.status).toBe(200);
    const { raw, token } = cookieOf(paired);
    expect(raw).toMatch(/Path=\/;/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Max-Age=15552000');
    expect(raw).toContain('__Host-wallet_scan=wls_');
    const session = (await paired.json()) as {
      principal: string;
      state: string;
      csrfToken: string;
      scanner: { id: string; mode: string; orgName: string };
    };
    expect(session).toMatchObject({
      principal: 'scanner',
      state: 'ready',
      scanner: { id: body.id, mode: 'live', orgName: 'Test Org' },
    });
    expect(session.csrfToken).toBeTruthy();
    const auth = await createScannerStore(env, clock).resolve(token, 'cookie');
    expect(auth).toMatchObject({
      scannerId: body.id,
      orgId,
      mode: 'live',
      csrfSecret: session.csrfToken,
    });
    const state = await poll();
    expect(state.state).toBe('paired');
    expect(state.device?.label).toBe('iPhone · Safari');
    const dto = (await (await consoleCall('GET', `/${body.id}`)).json()) as {
      status: string;
      pairedLabel: string;
    };
    expect(dto).toMatchObject({ status: 'paired', pairedLabel: 'iPhone · Safari' });
  });

  it('unknown, expired and used codes give byte-equal PAIRING_INVALID', async () => {
    const { body } = await create();
    const code = body.pairing?.code ?? '';
    await pairCall('', code);
    const used = await pairCall('', code);
    const expired = await create();
    clock.advance(10 * 60_000 + 1);
    const late = await pairCall('', expired.body.pairing?.code ?? '');
    const unknown = await pairCall('', 'ABCDEFGHJK');
    const junk = await pairCall('', 'UUUUUUUUUU');
    const preview = await pairCall('/preview', code);
    for (const res of [used, late, unknown, junk, preview]) expect(res.status).toBe(400);
    const expected = await problem(unknown);
    expect(expected.code).toBe('PAIRING_INVALID');
    for (const res of [used, late, junk, preview]) expect(await problem(res)).toEqual(expected);
  });

  it('two concurrent pairs give one winner and one audit row', async () => {
    const { body } = await create();
    const code = body.pairing?.code ?? '';
    const results = await Promise.all([
      pairCall('', code, device()),
      pairCall('', code, { ...device(), 'cf-connecting-ip': '198.51.100.7' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await auditActions()).filter((a) => a === 'scanner.pair')).toHaveLength(1);
  });

  it('a new code voids the old one', async () => {
    const { body } = await create();
    const old = body.pairing?.code ?? '';
    const fresh = (await (await consoleCall('POST', `/${body.id}/pairing`)).json()) as {
      code: string;
    };
    expect(fresh.code).not.toBe(old);
    expect((await pairCall('/preview', old)).status).toBe(400);
    expect((await pairCall('/preview', fresh.code)).status).toBe(200);
  });

  it('re-pairing replaces the old token at completion', async () => {
    const { body } = await create();
    const first1 = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    expect(await store.resolve(first1, 'cookie')).not.toBeNull();
    const fresh = (await (await consoleCall('POST', `/${body.id}/pairing`)).json()) as {
      code: string;
    };
    expect(await store.resolve(first1, 'cookie')).not.toBeNull();
    const second = cookieOf(await pairCall('', fresh.code)).token;
    expect(await store.resolve(first1, 'cookie')).toBeNull();
    expect((await store.resolve(second, 'cookie'))?.scannerId).toBe(body.id);
  });

  it('caps misses per IP: the 31st is a 429, even for a good code', async () => {
    const { body } = await create();
    const headers = device();
    for (let i = 0; i < 30; i++)
      expect((await pairCall('', 'ABCDEFGHJK', headers)).status).toBe(400);
    const capped = await pairCall('', body.pairing?.code ?? '', headers);
    expect(capped.status).toBe(429);
    expect(capped.headers.get('retry-after')).toBeTruthy();
    expect(
      (
        await pairCall('', body.pairing?.code ?? '', {
          ...headers,
          'cf-connecting-ip': '198.51.100.9',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a cross-site request', async () => {
    const { body } = await create();
    const res = await pairCall('', body.pairing?.code ?? '', {
      ...device(),
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
  });

  it('a suspended org cannot pair', async () => {
    const { body } = await create();
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgId]);
    expect((await pairCall('', body.pairing?.code ?? '')).status).toBe(400);
  });

  it('unpair always answers 204, clears the cookie, and the token with it', async () => {
    const { body } = await create();
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const res = await send('POST', '/api/v1/scan/unpair', {
      ...device(),
      cookie: `__Host-wallet_scan=${token}`,
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('__Host-wallet_scan=;');
    expect(await createScannerStore(env, clock).resolve(token, 'cookie')).toBeNull();
    const again = await send('POST', '/api/v1/scan/unpair', device());
    expect(again.status).toBe(204);
    expect(await auditActions()).toContain('scanner.unpair');
  });

  it('pair here sets the cookie on the admin browser', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/pair-here`);
    expect(res.status).toBe(200);
    const { token } = cookieOf(res);
    expect((await createScannerStore(env, clock).resolve(token, 'cookie'))?.scannerId).toBe(
      body.id,
    );
    expect(((await res.json()) as { status: string }).status).toBe('paired');
  });
});

describe('revoke and mode', () => {
  it('revoke bites on the next request, keeps the token matching, and Pair again reactivates', async () => {
    const { body } = await create();
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const store = createScannerStore(env, clock);
    expect(await store.resolve(token, 'cookie')).not.toBeNull();
    const res = await consoleCall('POST', `/${body.id}/revoke`);
    expect(((await res.json()) as { status: string }).status).toBe('revoked');
    await expect(store.resolve(token, 'cookie')).rejects.toMatchObject({ code: 'SCANNER_REVOKED' });
    expect((await consoleCall('POST', `/${body.id}/revoke`)).status).toBe(200);
    expect((await auditActions()).filter((a) => a === 'scanner.revoke')).toHaveLength(1);
    const fresh = (await (await consoleCall('POST', `/${body.id}/pairing`)).json()) as {
      code: string;
    };
    const again = cookieOf(await pairCall('', fresh.code)).token;
    expect(await store.resolve(token, 'cookie')).toBeNull();
    expect((await store.resolve(again, 'cookie'))?.scannerId).toBe(body.id);
  });

  it("a revoked scanner's pending code is void", async () => {
    const { body } = await create();
    await consoleCall('POST', `/${body.id}/revoke`);
    expect((await pairCall('/preview', body.pairing?.code ?? '')).status).toBe(400);
  });

  it('Go live keeps the token and bumps configRev', async () => {
    const { body } = await create({ accepts: { templateIds: [templateId] } }, admin('test'));
    const token = cookieOf(await pairCall('', body.pairing?.code ?? '')).token;
    const before = await first<{ updated_at: number }>(
      env.DB,
      'SELECT updated_at FROM scanners WHERE id = ?',
      [body.id],
    );
    clock.advance(5_000);
    const res = await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe('live');
    const store = createScannerStore(env, clock);
    expect(await store.resolve(token, 'cookie')).toMatchObject({ mode: 'live' });
    const after = await first<{ updated_at: number }>(
      env.DB,
      'SELECT updated_at FROM scanners WHERE id = ?',
      [body.id],
    );
    expect(after?.updated_at).toBe((before?.updated_at ?? 0) + 5_000);
  });

  it('Go live is refused on an event of the old mode unless the event is detached in the call', async () => {
    const event = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const { body } = await create({ accepts: { eventId: event.id } }, admin('test'));
    const refused = await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' });
    expect(refused.status).toBe(422);
    expect(await codeOf(refused)).toBe('SCAN_MODE_MISMATCH');
    const ok = await consoleCall('POST', `/${body.id}/mode`, { mode: 'live', detachEvent: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { accepts: unknown }).accepts).toBeNull();
    expect(
      await first(env.DB, 'SELECT 1 AS x FROM scanners WHERE id = ? AND event_id IS NULL', [
        body.id,
      ]),
    ).not.toBeNull();
  });
});

describe('sample pass', () => {
  it('is for test scanners only', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/sample-pass`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SAMPLE_TEST_ONLY');
  });

  it('makes one test pass of the first accepted template with its sample inputs', async () => {
    clock.set(Date.now());
    const made = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, made.resolved);
    overrideDeps(env, { registry: made.registry });
    await ensurePlatformIdentity(env, clock.now());
    const { body } = await create({ accepts: { templateIds: [made.resolved.id] } }, admin('test'));
    const res = await consoleCall('POST', `/${body.id}/sample-pass`);
    expect(res.status).toBe(201);
    const sample = (await res.json()) as { passId: string; templateId: string };
    expect(sample.templateId).toBe(made.resolved.id);
    const pass = await first<{
      mode: string;
      holder_email: string | null;
      personalization: string;
    }>(env.DB, 'SELECT mode, holder_email, personalization FROM passes WHERE id = ?', [
      sample.passId,
    ]);
    expect(pass?.mode).toBe('test');
    expect(pass?.holder_email).toBeNull();
    expect(JSON.parse(pass?.personalization ?? '{}')).toEqual({ memberName: 'Alex Morgan' });
    expect(await auditActions()).toContain('scanner.sample_pass');
  });
});

describe('audit and secrets', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it('writes the audit rows of SA 2.11 and never the pairing code or a token', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const)
      spies.push(
        vi
          .spyOn(console, level)
          .mockImplementation((line: unknown) => void lines.push(String(line))),
      );
    const { body } = await create({ name: 'Audit' });
    const code = body.pairing?.code ?? '';
    await pairCall('/preview', code);
    await pairCall('', 'ABCDEFGHJK');
    const token = cookieOf(await pairCall('', code)).token;
    await consoleCall('PATCH', `/${body.id}`, { name: 'Audit 2' });
    await consoleCall('POST', `/${body.id}/mode`, { mode: 'test' });
    await consoleCall('POST', `/${body.id}/revoke`);
    const actions = await auditActions();
    expect(actions).toEqual(
      expect.arrayContaining([
        'scanner.create',
        'scanner.pairing_create',
        'scanner.pair_failed',
        'scanner.pair',
        'scanner.update',
        'scanner.mode_change',
        'scanner.revoke',
      ]),
    );
    const rows = await all<{ actor_type: string; detail: string | null; org_id: string | null }>(
      env.DB,
      'SELECT actor_type, detail, org_id FROM audit_log',
    );
    const blob = JSON.stringify(rows) + lines.join('\n');
    expect(blob).not.toContain(code);
    expect(blob).not.toContain('ABCDEFGHJK');
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(token.slice(4, 12));
    const pair = await first<{ actor_type: string; org_id: string }>(
      env.DB,
      "SELECT actor_type, org_id FROM audit_log WHERE action = 'scanner.pair'",
    );
    expect(pair).toEqual({ actor_type: 'scanner', org_id: orgId });
  });

  it('commits a change and its audit row together', async () => {
    await run(
      env.DB,
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      const { res } = await create({ name: 'Atomic' });
      expect(res.status).toBe(500);
      expect(await first(env.DB, "SELECT 1 AS x FROM scanners WHERE name = 'Atomic'")).toBeNull();
    } finally {
      await run(env.DB, 'DROP TRIGGER fail_audit');
    }
  });
});
