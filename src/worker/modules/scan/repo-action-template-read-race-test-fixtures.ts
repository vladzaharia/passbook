import { first } from '../../platform/db.ts';

/** Mutate the actual D1 state just before the batch that would commit an action or its grants. */
export function beforeBatch(
  db: D1Database,
  marker: string,
  change: (db: D1Database) => Promise<unknown>,
) {
  const matched = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(marker)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  matched.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => matched.has(statement))) {
            fired = true;
            await change(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, fired: () => fired };
}

export async function effects(
  db: D1Database,
  passId: string,
  idempotencyKey: string,
  orgId: string,
) {
  return first<{ scans: number; gates: number; presence: number; events: number; grants: number }>(
    db,
    `SELECT
    (SELECT count(*) FROM scans WHERE idempotency_key=? AND NOT (state='failed' AND outcome IS NULL)) AS scans,
    (SELECT count(*) FROM scan_gates WHERE pass_id=?) AS gates,
    (SELECT count(*) FROM scan_presence WHERE pass_id=?) AS presence,
    (SELECT count(*) FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%') AS events,
    (SELECT count(*) FROM scan_asset_grant_provenance WHERE org_id=?) AS grants`,
    [idempotencyKey, passId, passId, passId, orgId],
  );
}
