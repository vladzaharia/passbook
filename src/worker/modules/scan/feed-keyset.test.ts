import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession, makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import {
  codeOf,
  DAY,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let admin: Record<string, string>;
let apiKey: Record<string, string>;
let membershipId: string;

beforeEach(async () => {
  kit = await setupScanKit();
  const fake = fakeAuth(ORIGIN);
  fake.bindApiKeys(kit.env, kit.clock);
  const user = await makeUser(kit.fx);
  membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
  admin = {
    ...(await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] })).headers,
    origin: ORIGIN,
  };
  apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
  app = createApp({
    stores: {
      ...fake.stores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const get = (path: string, headers = admin) =>
  Promise.resolve(app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, kit.env));
const exportPath = () =>
  `/export?orgId=${kit.org.id}&from=${kit.clock.now() - DAY}&to=${kit.clock.now() + DAY}`;

async function recorded(count = 1) {
  const templateId = await kit.scanTemplate('Keyset history', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await kit.scanPass(templateId, { memberName: 'Keyset private title' });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    kit.clock.advance(1000);
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('The signed scan must have an id.');
    ids.push(outcome.scanId);
  }
  return { scanner, pass, ids };
}

type Race = 'capture' | 'selection' | 'audit' | 'fallback';

/** Simulate an out-of-band keyset replacement after capture; production's trigger prevents this. */
async function withRekey<T>(
  race: Race,
  work: () => Promise<T>,
  afterSelection?: () => Promise<unknown>,
): Promise<T> {
  const db = kit.env.DB;
  const original = await ensureCredentialRefKeyset(db, kit.env);
  const replacement = original === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
  const marked = new WeakSet<D1PreparedStatement>();
  let fired = false;
  let selected = false;
  let captures = 0;
  const rekey = async () => {
    await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [replacement]);
    fired = true;
  };
  const wrapRead = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrapRead(target.bind(...values));
        if (property === 'first' || property === 'all')
          return async () => {
            const result = property === 'first' ? await target.first() : await target.all();
            if (!fired && race === 'selection') await rekey();
            if (!selected && race === 'fallback') {
              if (!afterSelection) throw new Error('The fallback race needs a change.');
              selected = true;
              await afterSelection();
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          const capture = sql.includes('INSERT INTO credential_ref_keyset');
          const audit = sql.includes('INSERT INTO audit_log') && sql.includes("'scan.export'");
          const fallback =
            (sql.startsWith('SELECT s.id, s.org_id, s.mode, s.at,') &&
              /WHERE[\s(]*s\.id IN \(/.test(sql)) ||
            sql.startsWith('WITH requested AS MATERIALIZED');
          if (capture) captures++;
          if (
            (race === 'capture' && capture) ||
            (race === 'audit' && audit) ||
            (race === 'fallback' && fallback)
          ) {
            return new Proxy(statement, {
              get(prepared, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    marked.add(bound);
                    return bound;
                  };
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          }
          if (
            (race === 'selection' || race === 'fallback') &&
            sql.startsWith('SELECT s.id, s.org_id, s.mode, s.at,') &&
            /(ORDER BY s\.at DESC|WHERE\s+s\.id\s*=\s*\?)/i.test(sql)
          )
            return wrapRead(statement);
          return statement;
        };
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const match = statements.some((statement) => marked.has(statement));
          if (!fired && race === 'audit' && match) await rekey();
          const result = await target.batch(statements);
          if (!fired && race === 'capture' && match) await rekey();
          if (!fired && race === 'fallback' && selected && match) await rekey();
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await work();
    expect(fired).toBe(true);
    expect(captures).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
    await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [original]);
    await run(
      db,
      `CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
      BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
    );
  }
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
}

describe('scan history keyset fences', () => {
  it.each(['console', 'key'] as const)(
    'fails closed for an empty %s page after the captured keyset changes',
    async (surface) => {
      const path = surface === 'console' ? `?orgId=${kit.org.id}` : '';
      const headers = surface === 'console' ? admin : apiKey;
      await withRekey(surface === 'console' ? 'capture' : 'selection', async () => {
        await expectUnavailable(await get(path, headers));
      });
    },
  );

  it('keeps the staff-hidden API-key fast path independent of the keyset', async () => {
    const db = kit.env.DB;
    const original = await ensureCredentialRefKeyset(db, kit.env);
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
    try {
      await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
        'a'.repeat(64),
      ]);
      const response = await get('?staffId=missing', apiKey);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], nextCursor: null });
      expect(await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1')).toEqual({
        commitment: 'a'.repeat(64),
      });
    } finally {
      await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [original]);
      await run(
        db,
        `CREATE TRIGGER credential_ref_keyset_no_update BEFORE UPDATE ON credential_ref_keyset
        BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
      );
    }
  });

  it.each(['console', 'key'] as const)(
    'does not bootstrap a keyset after %s authority is revoked',
    async (surface) => {
      const db = kit.env.DB;
      await withoutTrigger(db, 'credential_ref_keyset_no_delete', async () => {
        await run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1');
      });
      const marked = new WeakSet<D1PreparedStatement>();
      let fired = false;
      const proxy = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('INSERT INTO credential_ref_keyset')) return statement;
              return new Proxy(statement, {
                get(prepared, member) {
                  if (member === 'bind')
                    return (...values: unknown[]) => {
                      const bound = prepared.bind(...values);
                      marked.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(prepared, member, prepared);
                  return typeof value === 'function' ? value.bind(prepared) : value;
                },
              });
            };
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired && statements.some((statement) => marked.has(statement))) {
                fired = true;
                if (surface === 'console')
                  await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                    kit.clock.now(),
                    membershipId,
                  ]);
                else
                  await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE org_id = ?', [
                    kit.clock.now(),
                    kit.org.id,
                  ]);
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      try {
        const response =
          surface === 'console' ? await get(`?orgId=${kit.org.id}`) : await get('', apiKey);
        expect(response.status).toBe(surface === 'console' ? 403 : 401);
        expect(fired).toBe(true);
        expect(
          await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
        ).toBeNull();
      } finally {
        Object.assign(kit.env, { DB: db });
      }
    },
  );

  it.each(['console', 'key', 'detail'] as const)(
    'does not return signed %s history after a selection races a keyset change',
    async (surface) => {
      const { pass, ids } = await recorded();
      const path =
        surface === 'console' ? `?orgId=${kit.org.id}` : surface === 'key' ? '' : `/${ids[0]}`;
      const headers = surface === 'key' ? apiKey : admin;
      const baseline = await get(path, headers);
      expect(baseline.status).toBe(200);
      expect(await baseline.text()).toContain(pass.id);
      await withRekey('selection', async () => {
        await expectUnavailable(await get(path, headers));
      });
    },
  );

  it.each(['console', 'key'] as const)(
    'fences a %s continuation and does not downgrade a stale keyset to minimal history',
    async (surface) => {
      const { pass } = await recorded(2);
      const headers = surface === 'key' ? apiKey : admin;
      const prefix = surface === 'key' ? '?limit=1' : `?orgId=${kit.org.id}&limit=1`;
      const page = await get(prefix, headers);
      expect(page.status).toBe(200);
      const { nextCursor } = (await page.json()) as { nextCursor: string | null };
      expect(nextCursor).toEqual(expect.any(String));
      await withRekey(
        'fallback',
        async () => {
          await expectUnavailable(
            await get(`${prefix}&cursor=${encodeURIComponent(nextCursor!)}`, headers),
          );
        },
        // A pass link change (not a scanner rename: names are not authority) makes the selected
        // projection stale, so the page must fall back to minimal history.
        () =>
          run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
            pass.id,
          ]),
      );
    },
  );

  it('does not write an export audit if the keyset changes before its CAS', async () => {
    await recorded();
    await withRekey('audit', async () => {
      await expectUnavailable(await get(exportPath()));
    });
    expect(
      await first(kit.env.DB, "SELECT id FROM audit_log WHERE action = 'scan.export'"),
    ).toBeNull();
  });

  it('fails an export stream instead of emitting a page after its keyset changes', async () => {
    const { pass } = await recorded();
    await withRekey('selection', async () => {
      const response = await get(exportPath());
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const firstChunk = await reader.read();
      const header = new TextDecoder().decode(firstChunk.value);
      expect(header).not.toContain(pass.id);
      expect(header).not.toContain('Keyset private title');
      await expect(reader.read()).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
    });
  });

  it('keeps the original KEK ring through a streamed export when the live environment changes', async () => {
    await recorded();
    const db = kit.env.DB;
    const originalKey = kit.env.KEK_V1;
    let changed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === 'all')
            return async () => {
              const result = await target.all();
              if (!changed) {
                changed = true;
                kit.env.KEK_V1 = btoa('z'.repeat(32));
              }
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const proxy = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.startsWith('SELECT s.id, s.org_id, s.mode, s.at,') &&
              /ORDER BY s\.at DESC/i.test(sql)
              ? wrap(statement)
              : statement;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: proxy });
    try {
      const response = await get(exportPath());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Entry');
      expect(changed).toBe(true);
    } finally {
      Object.assign(kit.env, { DB: db, KEK_V1: originalKey });
    }
  });
});
