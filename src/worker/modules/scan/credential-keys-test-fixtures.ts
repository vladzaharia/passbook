import { expect, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';

/** How each secret looks when it is first shown. */
export const FORMAT = {
  pin: /^\d{6}$/,
  code: /^[0-9A-HJKMNP-TV-Z]{10}$/,
  url: /#pair=[0-9A-HJKMNP-TV-Z]{10}$/,
  token: /^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/,
  keys: /^[0-9a-f]{32}$/,
} as const;

const NETWORK = '203.0.113.7';

/** The app, the keys of every row of the parity table, and the scanners they act on. */
export function credentialKeysFixture() {
  const fixture = scanningSessionsFixture();
  let app: ReturnType<typeof createApp>;
  let templateId = '';
  let sequence = 0;
  const output: string[] = [];

  async function setup() {
    await fixture.setup();
    const { kit } = fixture;
    app = createApp({
      stores: {
        ...fixture.fake.stores,
        apiKeys: createApiKeyStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    templateId = await eventTemplate(kit, 'Credential ticket');
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
  }

  const orgId = () => fixture.kit.org.id;
  const env = () => fixture.kit.env;
  /** A credential scope counts only on a key that expires within 90 days (the use-time filter). */
  const key = (scopes: string[], over: Parameters<typeof makeApiKey>[1] = {}) =>
    makeApiKey(fixture.kit.fx, {
      orgId: orgId(),
      scopes,
      mode: 'live',
      expiresAt: fixture.kit.clock.now() + 30 * 86_400_000,
      ...over,
    });

  /** Every key of the parity table, made fresh so each has its own budgets. */
  async function keys() {
    const other = await makeOrg(fixture.kit.fx);
    const revoked = await key(['scanning:admin']);
    await run(env().DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      fixture.kit.clock.now(),
      revoked.id,
    ]);
    const expired = await key(['scanning:admin'], { expiresAt: fixture.kit.clock.now() + 1000 });
    return {
      otherOrgId: other.id,
      admin: await key(['scanning:admin']),
      write: await key(['scanning:write']),
      read: await key(['scan-setup:read']),
      nfc: await key(['nfc:keys']),
      platform: await key(['scanning:admin'], { orgId: null, kind: 'platform' }),
      otherOrg: await makeApiKey(fixture.kit.fx, {
        orgId: other.id,
        scopes: ['scanning:admin'],
        mode: 'live',
        expiresAt: fixture.kit.clock.now() + 30 * 86_400_000,
      }),
      testAdmin: await key(['scanning:admin'], { mode: 'test' }),
      restricted: await key(['scanning:admin'], { templateIds: [templateId] }),
      revoked,
      expired,
    };
  }

  const send = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    idempotencyKey?: string,
    /** Another env (a database that does something mid-call); the real one by default. */
    over: ReturnType<typeof env> = env(),
  ): Promise<Response> =>
    Promise.resolve(
      app.request(
        `https://wallet.test/api/v1${path}`,
        {
          method,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'cf-connecting-ip': NETWORK,
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        over,
      ),
    );

  /** A live scanner made through the console (a device comes with a code of its own). */
  async function scanner(kind: 'device' | 'terminal' = 'device') {
    const res = await fixture.call('POST', '/scanners', {
      orgId: orgId(),
      name: `Credential ${kind} ${++sequence}`,
      kind,
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  const auditRows = (target: string, action?: string) =>
    all<{ actor_type: string; actor_id: string | null; ip_prefix: string | null; detail: string }>(
      env().DB,
      `SELECT actor_type, actor_id, ip_prefix, detail FROM audit_log WHERE target_id = ?${
        action ? ' AND action = ?' : ''
      } ORDER BY id`,
      action ? [target, action] : [target],
    );
  /** The rows a key wrote (the console's own setup rows are not it). */
  const keyAudit = async (target: string, action: string) =>
    (await auditRows(target, action)).filter((r) => r.actor_type === 'api_key');
  const auditCount = async () =>
    (await first<{ n: number }>(env().DB, 'SELECT count(*) AS n FROM audit_log'))?.n ?? 0;

  /** The scanner row as stored: no column may hold a secret. */
  const rowText = async (id: string, table: 'scanners' | 'scan_staff' = 'scanners') =>
    JSON.stringify(await first(env().DB, `SELECT * FROM ${table} WHERE id = ?`, [id]));
  /** A field by dotted path; null when a step is missing (a replay nulls `pairing`). */
  const at = (value: unknown, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null),
        value,
      ) ?? null;

  /**
   * Once-only proof (design section 6): the first answer has each secret in its format; a replay with
   * the same key, header and body returns the same status and ids with every secret null, flagged; no
   * store, row, log or read shows a secret; both answers are no-store.
   */
  async function expectOnce(o: {
    first: Response;
    replay: Response;
    secrets: Record<string, RegExp>;
    ids: string[];
    keyId: string;
    action: string;
    /** The target's id, or how to read it from the first answer (a call that makes the target). */
    target: string | ((first: Record<string, unknown>) => string);
    table?: 'scanners' | 'scan_staff';
    reads: string[];
  }) {
    expect(o.first.status).toBeLessThan(300);
    const one = (await o.first.clone().json()) as Record<string, unknown>;
    const again = (await o.replay.clone().json()) as Record<string, unknown>;
    const target = typeof o.target === 'function' ? o.target(one) : o.target;
    const values = Object.keys(o.secrets).map((name) => {
      expect(at(one, name), name).toMatch(o.secrets[name] as RegExp);
      return String(at(one, name));
    });
    expect(o.replay.status).toBe(o.first.status);
    expect(o.replay.headers.get('idempotent-replayed')).toBe('true');
    expect(o.first.headers.get('idempotent-replayed')).toBeNull();
    for (const id of o.ids) expect(at(again, id), id).toEqual(at(one, id));
    for (const name of Object.keys(o.secrets)) expect(at(again, name), name).toBeNull();
    for (const r of [o.first, o.replay]) expect(r.headers.get('cache-control')).toMatch(/no-store/);
    const stored = await all<{ body: string | null; request_hash: string }>(
      env().DB,
      'SELECT body, request_hash FROM idempotent_requests',
    );
    const audits = await all(env().DB, 'SELECT * FROM audit_log');
    const place = {
      idempotent: JSON.stringify(stored),
      audit: JSON.stringify(audits),
      logs: output.join('\n'),
      row: await rowText(target, o.table),
      reads: o.reads.join('\n'),
    };
    for (const [name, text] of Object.entries(place))
      for (const v of values) expect(text.includes(v), `${name} holds a secret`).toBe(false);
    expect(output.join('\n')).not.toMatch(/wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}/);
    const rows = await keyAudit(target, o.action);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_type: 'api_key', actor_id: o.keyId });
      expect(r.ip_prefix).toBe(`${NETWORK.split('.').slice(0, 3).join('.')}.0/24`);
    }
  }

  /** Another key sending the same header value runs fresh; the same key with another body is refused. */
  async function expectIdempotencyScope(o: {
    other: Record<string, string>;
    /** `variant` changes the request (the restore flag) but not the header value. */
    run: (headers: Record<string, string>, variant?: boolean) => Promise<Response>;
    secret: string;
    firstSecret: string;
  }) {
    const fresh = await (await o.run(o.other)).json();
    expect(at(fresh, o.secret)).not.toBeNull();
    expect(at(fresh, o.secret)).not.toBe(o.firstSecret);
    await expectProblem(await o.run(o.other, true), 422, 'IDEMPOTENCY_KEY_REUSED');
  }

  return {
    fixture,
    setup,
    orgId,
    env,
    keys,
    key,
    send,
    scanner,
    auditRows,
    keyAudit,
    auditCount,
    rowText,
    expectOnce,
    at,
    templateId: () => templateId,
    expectIdempotencyScope,
    output,
  };
}
