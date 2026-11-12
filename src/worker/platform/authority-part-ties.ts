// Tie lints of an include write part: the tenant, mode and pass columns it writes or filters on.
import { AuthorityError } from './authority-error.ts';
import type { GrantScope } from './authority-principal.ts';
import {
  closeOf,
  hasConjunct,
  isConjunct,
  splitTopLevel,
  type WriteKind,
} from './authority-sqltext.ts';

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** `alias.column = {marker}` (either side), held as a conjunct of the part or of the alias's own `level`. */
export const tied = (text: string, alias: string, column: string, marker: string, level = -1) =>
  hasConjunct(
    text,
    new RegExp(
      `\\b${alias}\\.${column}\\s*=\\s*\\{${marker}\\}|\\{${marker}\\}\\s*=\\s*${alias}\\.${column}\\b`,
      'gi',
    ),
    { level },
  );

export function insertExpressions(text: string): { columns: string[]; rows: string[][] } | null {
  const head =
    /\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+\w+\s*\(([^)]*)\)\s*(SELECT|VALUES)\b/i.exec(
      text,
    );
  if (!head) return null;
  const columns = (head[1] ?? '').split(',').map((c) => c.trim().toLowerCase());
  const tail = text.slice(head.index + head[0].length);
  if ((head[2] ?? '').toUpperCase() === 'SELECT') {
    const end = /\b(?:FROM|WHERE|ON\s+CONFLICT|RETURNING)\b/i.exec(tail)?.index ?? tail.length;
    return { columns, rows: [splitTopLevel(tail.slice(0, end))] };
  }
  const rows: string[][] = [];
  let depth = 0;
  let from = -1;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === '(') {
      if (depth++ === 0) from = i + 1;
    } else if (tail[i] === ')' && --depth === 0) rows.push(splitTopLevel(tail.slice(from, i)));
    else if (depth === 0 && /\bON\s+CONFLICT\b/i.test(tail.slice(i, i + 12))) break;
  }
  return { columns, rows };
}

/** The tenant column rule of one write: `{marker}` at the column of an insert, or the equality in the WHERE. */
export function lintColumn(
  kind: WriteKind,
  table: string,
  text: string,
  column: string,
  marker: string,
  ins: ReturnType<typeof insertExpressions>,
): void {
  const need = `${table} must tie ${column} to {${marker}}.`;
  if (kind === 'insert') {
    const at = ins?.columns.indexOf(column) ?? -1;
    if (!ins || at < 0 || ins.rows.length === 0) throw override(need);
    for (const row of ins.rows) if ((row[at] ?? '').trim() !== `{${marker}}`) throw override(need);
    return;
  }
  const own = new RegExp(
    `(?<![\\w.])${column}\\s*=\\s*\\{${marker}\\}|\\b${table}\\.${column}\\s*=\\s*\\{${marker}\\}|\\{${marker}\\}\\s*=\\s*${table}\\.${column}\\b`,
    'g',
  );
  if (!hasConjunct(text, own)) throw override(need);
}

/** A row pinned through its transfer: the transfer row of `{pass}` is the one the write names. */
export function lintTransferPin(
  kind: WriteKind,
  table: string,
  text: string,
  column: string,
  ins: ReturnType<typeof insertExpressions>,
): void {
  const need = `${table} must be tied to a transfer of {pass}.`;
  const m = /\bFROM\s+pass_credential_transfers\s+(?:AS\s+)?([a-z_]\w*)\s+WHERE\b/i.exec(text);
  const alias = m?.[1];
  if (!alias || !tied(text, alias, 'pass_id', 'pass')) throw override(need);
  if (kind === 'insert') {
    const at = ins?.columns.indexOf(column) ?? -1;
    if (!ins || at < 0 || ins.rows.some((r) => (r[at] ?? '').trim() !== `${alias}.id`))
      throw override(need);
    return;
  }
  if (!hasConjunct(text, new RegExp(`\\b${alias}\\.id\\s*=\\s*(?:${table}\\.)?${column}\\b`, 'g')))
    throw override(need);
}

/**
 * Under a tenant grant a pass-bearing row is tied to a pass of the grant's tenant, as `{pass}` ties it under a
 * holder grant: `pass_id IN (SELECT p.id FROM passes p WHERE p.org_id = {org} AND p.mode = {mode} ...)`, an
 * `EXISTS` over `passes p` with `p.id = pass_id`, or (insert) `p.id` selected from such a `passes p`.
 */
export function lintPassTie(
  kind: WriteKind,
  table: string,
  text: string,
  scope: GrantScope,
  ins: ReturnType<typeof insertExpressions>,
): void {
  const col = `(?:\\b${table}\\.|(?<![\\w.]))pass_id`;
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+passes\s+(?:AS\s+)?([a-z_]\w*)/gi)) {
    const p = m[1] ?? '';
    if (!tied(text, p, 'org_id', 'org') || (scope === 'org_mode' && !tied(text, p, 'mode', 'mode')))
      continue;
    if (kind === 'insert') {
      const at = ins?.columns.indexOf('pass_id') ?? -1;
      if (
        ins &&
        at >= 0 &&
        ins.rows.length > 0 &&
        ins.rows.every((r) => (r[at] ?? '').trim() === `${p}.id`)
      )
        return;
      continue;
    }
    if (
      hasConjunct(
        text,
        new RegExp(`${col}\\s*=\\s*${p}\\.id\\b|\\b${p}\\.id\\s*=\\s*${col}\\b`, 'gi'),
      )
    )
      return;
    const head = `${col}\\s+IN\\s*\\(\\s*SELECT\\s+(?:${p}\\.)?id\\s+FROM\\s+passes\\s+(?:AS\\s+)?${p}\\b`;
    for (const h of text.matchAll(new RegExp(head, 'gi'))) {
      const open = (h.index ?? 0) + h[0].indexOf('(');
      if (isConjunct(text, h.index ?? 0, closeOf(text, open) + 1)) return;
    }
  }
  throw override(
    `${table} must tie pass_id to a pass of {org}${scope === 'org_mode' ? ' and {mode}' : ''}.`,
  );
}
