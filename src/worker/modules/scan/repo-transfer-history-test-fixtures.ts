import { all, first } from '../../platform/db.ts';
import type { CredentialTransferResult } from '../passes/credential-transfer.ts';

/** Snapshot only pass-bound effects; a not-found attempt may legitimately create a passless receipt. */
export async function effects(db: D1Database, passId: string) {
  return {
    pass: await first(db, 'SELECT * FROM passes WHERE id = ?', [passId]),
    gates: await all(db, 'SELECT * FROM scan_gates WHERE pass_id = ? ORDER BY action_id, scope', [
      passId,
    ]),
    presence: await all(db, 'SELECT * FROM scan_presence WHERE pass_id = ? ORDER BY scope', [
      passId,
    ]),
    scans: await all(db, 'SELECT * FROM scans WHERE pass_id = ? ORDER BY id', [passId]),
    events: await all(
      db,
      "SELECT * FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%' ORDER BY id",
      [passId],
    ),
  };
}

/** Execute a real transfer after card-history rows were read, before their final output fence. */
export function raceCardHistory(db: D1Database, start: () => Promise<CredentialTransferResult>) {
  const history = new WeakSet<D1PreparedStatement>();
  let transfer: CredentialTransferResult | undefined;
  let fired = false;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('WITH selected_scans AS MATERIALIZED')) return statement;
          return new Proxy(statement, {
            get(prepared, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  history.add(bound);
                  return bound;
                };
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (!fired && statements.some((statement) => history.has(statement))) {
            fired = true;
            transfer = await start();
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, fired: () => fired, transfer: () => transfer };
}
