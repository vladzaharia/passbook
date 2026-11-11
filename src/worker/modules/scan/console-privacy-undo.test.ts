import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { action } from './console-privacy-actions-test-fixtures.ts';
import {
  admin,
  adminMembershipId,
  adminSessionId,
  adminUserId,
  app,
  kit,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { grantScanMembership, key, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('console undo tenant authority', () => {
  interface Effects {
    pass: unknown;
    gates: unknown[];
    scans: unknown[];
    ledger: unknown[];
    presence: unknown[];
    audit: unknown[];
  }

  async function effects(db: D1Database, passId: string): Promise<Effects> {
    return {
      pass: await first(db, 'SELECT * FROM passes WHERE id = ?', [passId]),
      gates: await all(db, 'SELECT * FROM scan_gates WHERE pass_id = ? ORDER BY action_id, scope', [
        passId,
      ]),
      scans: await all(db, 'SELECT * FROM scans WHERE pass_id = ? ORDER BY id', [passId]),
      ledger: await all(
        db,
        "SELECT * FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%' ORDER BY id",
        [passId],
      ),
      presence: await all(db, 'SELECT * FROM scan_presence WHERE pass_id = ? ORDER BY scope', [
        passId,
      ]),
      audit: await all(
        db,
        "SELECT * FROM audit_log WHERE org_id = ? AND action LIKE 'scan.%' ORDER BY id",
        [kit.org.id],
      ),
    };
  }

  async function sendUndo(scanId: string, idempotencyKey: string, headers = admin) {
    return app.request(
      `${ORIGIN}/api/v1/scans/${scanId}/undo`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey }),
      },
      kit.env,
    );
  }

  it('allows a non-platform pass operator to undo a real scan', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const { original } = await action(scanner, pass);
    if (!original.scanId) throw new Error('A successful scan must have an id.');
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const headers = { ...(await makeSession(kit.fx, { userId: user.id })).headers, origin: ORIGIN };
    const response = await sendUndo(original.scanId, key(), headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', replay: false });
    expect(
      await first(kit.env.DB, 'SELECT undone_by IS NOT NULL AS undone FROM scans WHERE id = ?', [
        original.scanId,
      ]),
    ).toEqual({ undone: 1 });
    expect(
      await first(
        kit.env.DB,
        "SELECT action FROM audit_log WHERE action = 'scan.undo' AND target_id = ?",
        [original.scanId],
      ),
    ).toEqual({ action: 'scan.undo' });
  });

  it.each([
    'membership revoked',
    'session revoked',
    'membership replaced',
    'role downgraded',
  ] as const)('fences undo when the captured %s races the batch', async (change) => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const { original } = await action(scanner, pass);
    if (!original.scanId) throw new Error('A successful scan must have an id.');
    const idempotencyKey = key();
    const db = kit.env.DB;
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    let intercepted = 0;
    let before: Effects | undefined;
    const proxy = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(prepared, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    sqlOf.set(bound, sql);
                    return bound;
                  };
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
        }
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (
              intercepted === 0 &&
              statements.some((statement) =>
                /\bUPDATE\s+scan_gates\s+SET\b/i.test(sqlOf.get(statement) ?? ''),
              )
            ) {
              intercepted++;
              const sessionRevoked = change === 'session revoked';
              const sql = sessionRevoked
                ? 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?'
                : 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?';
              const id = sessionRevoked ? adminSessionId : adminMembershipId;
              expect(await run(db, sql, [kit.clock.now(), id])).toEqual({ changes: 1 });
              if (change === 'membership replaced' || change === 'role downgraded') {
                await grantScanMembership(
                  kit.fx,
                  kit.org.id,
                  adminUserId,
                  change === 'membership replaced' ? ['org_admin'] : ['read_only'],
                );
              }
              before = await effects(db, pass.id);
              expect(before.gates).toHaveLength(1);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: proxy });
    let response: Response;
    try {
      response = await sendUndo(original.scanId, idempotencyKey);
    } finally {
      Object.assign(kit.env, { DB: db });
    }
    expect(intercepted).toBe(1);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(before).toBeDefined();
    expect(await effects(db, pass.id)).toEqual(before);
    expect(
      await first(db, 'SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toBeNull();
  });
});
