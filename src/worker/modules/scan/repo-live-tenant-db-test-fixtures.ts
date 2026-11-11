import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanKit } from './test-kit.ts';

interface StoredSession {
  id_hash: string;
  user_id: string;
  amr: string;
  roles: string;
  csrf_secret: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip_prefix: string | null;
  user_agent: string | null;
}

export async function storedSession(kit: ScanKit, id: string): Promise<StoredSession> {
  const row = await first<StoredSession>(kit.env.DB, 'SELECT * FROM sessions WHERE id_hash=?', [
    id,
  ]);
  if (!row) throw new Error('Missing platform session.');
  return row;
}

export function insertSession(kit: ScanKit, row: StoredSession, secret: string) {
  return run(
    kit.env.DB,
    `INSERT INTO sessions
    (id_hash,user_id,amr,roles,csrf_secret,created_at,last_seen_at,idle_expires_at,
     expires_at,revoked_at,ip_prefix,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id_hash,
      row.user_id,
      row.amr,
      row.roles,
      secret,
      row.created_at,
      row.last_seen_at,
      row.idle_expires_at,
      row.expires_at,
      row.revoked_at,
      row.ip_prefix,
      row.user_agent,
    ],
  );
}

export function revokeLiveTenantFixtureMembership(db: D1Database, revokedAt: number, id: string) {
  return run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [revokedAt, id]);
}

/** Interleave a real D1 mutation before the final recipient SELECT or read-only batch. */
export function raceFinalFence(
  kit: ScanKit,
  mutate: () => Promise<unknown>,
): {
  ctx: ServiceContext;
  reached: () => boolean;
  bound: () => readonly unknown[];
  statement: () => string;
} {
  let reached = false;
  let bound: readonly unknown[] = [];
  let statement = '';
  type Tracked = { inner: D1PreparedStatement; sql: string; args: readonly unknown[] };
  const tracked = new WeakMap<D1PreparedStatement, Tracked>();
  async function interleave(final: Tracked) {
    if (reached) return;
    reached = true;
    statement = final.sql;
    bound = final.args;
    await mutate();
  }
  function wrap(
    inner: D1PreparedStatement,
    sql: string,
    args: readonly unknown[] = [],
  ): D1PreparedStatement {
    const final = { inner, sql, args };
    const wrapped = new Proxy(inner, {
      get(target, key) {
        if (key === 'bind')
          return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        if (key === 'first') {
          return async (column?: string) => {
            await interleave(final);
            return column === undefined ? target.first() : target.first(column);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    tracked.set(wrapped, final);
    return wrapped;
  }
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return /scan-ephemeral-csrf:recipient:(?:session|scanner)/i.test(sql)
            ? wrap(prepared, sql)
            : prepared;
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const final = statements
            .map((item) => tracked.get(item))
            .find((item) => item !== undefined);
          if (final) await interleave(final);
          return target.batch(statements.map((item) => tracked.get(item)?.inner ?? item));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return {
    ctx: { ...kit.ctx, env },
    reached: () => reached,
    bound: () => bound,
    statement: () => statement,
  };
}
