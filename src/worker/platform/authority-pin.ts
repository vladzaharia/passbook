// The pass pin of a holder grant: it writes rows of its own pass and nothing else (builder-ext design 8.2).
import { AuthorityError } from './authority-error.ts';
import type { WhereValue } from './authority-expr.ts';
import type { TableScope } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** Under a holder grant a table must declare its pass column. */
export function holderTable(t: TableScope, table: string, pin: string | undefined): void {
  if (pin !== undefined && !t.pass) throw override(`${table} is not written under a holder grant.`);
}

/**
 * The SQL pin of an update, delete or joined parent. `outbox` carries its pass only on rows made for a
 * pass; the issuance delivery that owns the outbox row is the other proof.
 */
export function pinPredicate(
  t: TableScope,
  table: string,
  alias: string,
  pin: string | undefined,
): string {
  if (pin === undefined || !t.pass) return '';
  if (table === 'outbox')
    return ` AND (${alias}.pass_id = g.target_id OR EXISTS (SELECT 1 FROM pass_issuance_deliveries d WHERE d.outbox_id = ${alias}.id AND d.pass_id = g.target_id))`;
  return ` AND g.target_id = ${alias}.${t.pass}`;
}

/** A `where` that names the pass column may name only the grant's pass. */
export function pinWhere(
  t: TableScope,
  table: string,
  where: Record<string, WhereValue>,
  pin: string | undefined,
): void {
  if (pin === undefined || !t.pass || !(t.pass in where)) return;
  if (where[t.pass] !== pin) throw override(`${table}.${t.pass} is pinned to the holder's pass.`);
}

/** An insert names the grant's pass: JS check on the value, and the SQL carries `g.target_id` too. */
export function pinInsert(
  t: TableScope,
  table: string,
  columns: string[],
  values: SqlValue[],
  copy: Record<string, string> | undefined,
  pin: string | undefined,
): { sql: string; params: SqlValue[] } {
  if (pin === undefined) return { sql: '', params: [] };
  holderTable(t, table, pin);
  const pass = t.pass ?? '';
  const at = columns.indexOf(pass);
  const source = copy?.[pass];
  if (at >= 0 && values[at] === pin) return { sql: ' AND g.target_id = ?', params: [pin] };
  if (at < 0 && source !== undefined) return { sql: ` AND g.target_id = s.${source}`, params: [] };
  throw override(`${table}.${pass} must be the holder's pass.`);
}
