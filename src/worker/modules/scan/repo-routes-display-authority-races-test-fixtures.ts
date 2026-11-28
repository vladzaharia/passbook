import { expect } from 'vitest';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { RACE_PREVIEW_AUDIT, RACE_PREVIEW_CURRENT } from './race-tags.ts';

export function previewAuthorityRaces(env: AppEnv) {
  /** Temporarily permit a sentinel mutation to exercise races across the real D1 read fences. */
  async function withMutableKeyset(work: (original: string, replacement: string) => Promise<void>) {
    const db = env.DB;
    const original = await ensureCredentialRefKeyset(db, env);
    const replacement = original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const trigger = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'credential_ref_keyset_no_update'",
    );
    if (!trigger?.sql) throw new Error('Missing credential keyset immutability trigger');
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
    try {
      await work(original, replacement);
    } finally {
      try {
        await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [original]);
      } finally {
        await run(db, trigger.sql);
      }
    }
  }

  /** Interleave once at a specific D1 read without changing the returned rows. */
  async function atPreviewRead(
    matches: (sql: string) => boolean,
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    const real = env.DB;
    let hits = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
          if (prop === 'first')
            return async (...args: unknown[]) => {
              if (hits === 0) {
                hits++;
                await intervene(real);
              }
              return (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return matches(sql) ? wrap(statement) : statement;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await operation();
      expect(hits).toBe(1);
      return response;
    } finally {
      Object.assign(env, { DB: real });
    }
  }

  /** Run a real D1 change after the scope is built, just before its audit is written. */
  async function atPreviewAudit(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    const real = env.DB;
    let hits = 0;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
          if (prop === 'run' && sql.includes(RACE_PREVIEW_AUDIT)) {
            return async (...args: unknown[]) => {
              if (hits++ === 0) await intervene(real);
              return (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.includes(RACE_PREVIEW_AUDIT) ? wrap(statement, sql) : statement;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await operation();
      expect(hits).toBe(1);
      return response;
    } finally {
      Object.assign(env, { DB: real });
    }
  }

  /** Interleave a D1 mutation at the post-audit authority read (`AS pass_ok`), once. */
  async function atPreviewOutputFence(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    const real = env.DB;
    let audited = false;
    let hits = 0;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
          if (prop === 'run' && sql.includes(RACE_PREVIEW_AUDIT))
            return async (...args: unknown[]) => {
              const result = await (value as (...values: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              );
              audited = true;
              return result;
            };
          if (prop === 'first' && sql.includes(RACE_PREVIEW_CURRENT))
            return async (...args: unknown[]) => {
              if (audited && hits === 0) {
                hits++;
                await intervene(real);
              }
              return (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.includes(RACE_PREVIEW_AUDIT) || sql.includes(RACE_PREVIEW_CURRENT)
              ? wrap(statement, sql)
              : statement;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(env, { DB: db });
    try {
      const response = await operation();
      expect(audited).toBe(true);
      expect(hits).toBe(1);
      return response;
    } finally {
      Object.assign(env, { DB: real });
    }
  }

  return {
    withMutableKeyset,
    atPreviewRead,
    atPreviewAudit,
    atPreviewOutputFence,
  };
}
