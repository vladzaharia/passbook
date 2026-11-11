import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  adminMembershipId,
  adminSessionId,
  exportPath,
  get,
  kit,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it.each(['membership', 'session'] as const)(
    'does not commit an export audit when its %s is revoked after counting',
    async (revoked) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      await recordedNoMatch(scanner);
      const db = kit.env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (property === 'first')
              return async () => {
                const result = await target.first();
                if (intercepted === 0) {
                  intercepted++;
                  const sql =
                    revoked === 'membership'
                      ? 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?'
                      : 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?';
                  const id = revoked === 'membership' ? adminMembershipId : adminSessionId;
                  expect(await run(db, sql, [kit.clock.now(), id])).toEqual({ changes: 1 });
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
              return /SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+\(SELECT\s+1\s+FROM\s+scans\s+s/i.test(
                sql,
              )
                ? wrap(statement)
                : statement;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      let response: Response;
      try {
        response = await get(exportPath());
      } finally {
        Object.assign(kit.env, { DB: db });
      }
      expect(intercepted).toBe(1);
      expect(response.status).toBe(403);
      expect(await first(db, "SELECT id FROM audit_log WHERE action = 'scan.export'")).toBeNull();
    },
  );

  it.each(['membership', 'session'] as const)(
    'does not stream a projected row when its %s is revoked during export',
    async (revoked) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      await recordedCheckIn(scanner, pass.id);
      const db = kit.env.DB;
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, prop) {
            if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (prop === 'all')
              return async () => {
                const result = await target.all();
                if (intercepted++ === 0) {
                  const sql =
                    revoked === 'membership'
                      ? 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?'
                      : 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?';
                  const id = revoked === 'membership' ? adminMembershipId : adminSessionId;
                  expect(await run(db, sql, [kit.clock.now(), id])).toEqual({ changes: 1 });
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
      Object.assign(kit.env, { DB: proxy });
      try {
        const response = await get(exportPath());
        expect(response.status).toBe(200);
        if (!response.body) throw new Error('Export must have a response body.');
        const reader = response.body.getReader();
        const header = await reader.read();
        expect(header.done).toBe(false);
        const text = new TextDecoder().decode(header.value);
        expect(text).toContain('Time (UTC)');
        expect(text).not.toContain(PUBLIC);
        await expect(reader.read()).rejects.toThrow();
        expect(intercepted).toBe(1);
      } finally {
        Object.assign(kit.env, { DB: db });
      }
    },
  );
});
