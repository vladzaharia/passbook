import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { HOUR, kit } from '../scan/act-test-fixtures.ts';

export const DAY = 24 * HOUR;
export const ctx = () => createJobContext(kit.env, 'visitors', { clock: kit.clock });

/** A pass on `plan` whose own end is now. */
export const pass = (
  template: string,
  plan = 'guest',
  over: { mode?: 'live' | 'test'; endsIn?: number } = {},
) =>
  kit.scanPass(
    template,
    { plan, validUntil: new Date(kit.clock.now() + (over.endsIn ?? 0)).toISOString() },
    over.mode ? { mode: over.mode } : {},
  );

export const row = (id: string) =>
  first<{ d: number | null; status: string }>(
    kit.env.DB,
    'SELECT deleted_at AS d, status FROM passes WHERE id = ?',
    [id],
  );
export const gone = async (id: string) => ((await row(id))?.d ?? null) !== null;

export const hold = (orgId: string, passId: string | null) =>
  run(
    kit.env.DB,
    "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)",
    [kit.fx.ids.id(), orgId, passId],
  );

export const receipts = (orgId: string | null) =>
  all<{ deleted: number; kind: string; policy_days: number }>(
    kit.env.DB,
    "SELECT deleted, kind, policy_days FROM retention_receipts WHERE class = 'visitors' AND org_id IS ? ORDER BY seq",
    [orgId],
  );

/**
 * An env whose DB runs `after` once: when the candidate read returns (`'read'`), or right before the batch that
 * holds the soft delete (`'batch'`), so a write can land in the window a real race would use.
 */
export function raced(when: 'read' | 'batch', after: () => Promise<void>) {
  let done = false;
  let armed = false;
  const fire = async () => {
    if (done) return;
    done = true;
    await after();
  };
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'batch' && when === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (armed) await fire();
          return target.batch(statements);
        };
      if (prop === 'prepare')
        return (sql: string) => {
          if (sql.includes('UPDATE passes SET deleted_at')) armed = true;
          const statement = target.prepare(sql);
          if (when !== 'read' || !sql.includes('pass_credential_transfers t WHERE'))
            return statement;
          return new Proxy(statement, {
            get(t, p) {
              if (p !== 'bind') return Reflect.get(t, p, t);
              return (...args: unknown[]) => {
                const bound = t.bind(...args);
                return new Proxy(bound, {
                  get(b, bp) {
                    if (bp === 'all')
                      return async () => {
                        const result = await b.all();
                        await fire();
                        return result;
                      };
                    const value = Reflect.get(b, bp, b);
                    return typeof value === 'function' ? value.bind(b) : value;
                  },
                });
              };
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return createJobContext({ ...kit.env, DB: db } as never, 'visitors', { clock: kit.clock });
}
