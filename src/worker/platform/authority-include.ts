// Parts built by side builders (retention proofs, counters, history) that commit only in a grant's batch.
// A part is inert data; markers bind the grant row, and the lints below tie it to the grant's tenant.
import { AuthorityError } from './authority-error.ts';
import type { GrantScope } from './authority-principal.ts';
import {
  assertReadOnly,
  assertSqlText,
  mapOutsideLiterals,
  splitTopLevel,
  stripLiterals,
  type WriteKind,
  writeTargetsOf,
} from './authority-sqltext.ts';
import type { BuiltStatement } from './authority-statements.ts';
import {
  APPEND_ONLY_TABLES,
  AUTHORITY_TABLES,
  GUARDED_TABLES,
  HOLDER_PART_PINS,
  MODE_BEARING_TABLES,
  ORG_BEARING_TABLES,
  PASS_BEARING_TABLES,
  TRIGGER_WRITES_GUARDED,
} from './authority-tables.ts';
import type { SqlValue } from './db.ts';

export interface GrantPart {
  readonly kind: 'read' | 'write';
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** A read-only SELECT whose tenant comes from `{org}` (`{grant}` for a platform grant). */
export const readPart = (sql: string, params: readonly SqlValue[] = []): GrantPart => ({
  kind: 'read',
  sql,
  params,
});
/** One write to a table outside the builder's guarded set; it must carry `{grant}`. */
export const writePart = (sql: string, params: readonly SqlValue[] = []): GrantPart => ({
  kind: 'write',
  sql,
  params,
});

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);
const banned = () =>
  new Set<string>([
    ...Object.keys(GUARDED_TABLES),
    ...AUTHORITY_TABLES,
    ...APPEND_ONLY_TABLES,
    ...TRIGGER_WRITES_GUARDED,
  ]);

/** The tables an unguarded statement writes. */
export function writeTargets(sql: string): string[] {
  return writeTargetsOf(assertSqlText(sql, 'An unguarded statement')).map((t) => t.table);
}

/** A legacy unguarded write: carries the grant row and targets no guarded, authority or append-only table. */
export function assertUnguarded(sql: string): void {
  const writes = writeTargets(sql);
  if (writes.length > 0 && !/\bauthority_grants\b/.test(sql))
    throw new AuthorityError(
      'GRANT_FOREIGN_STATEMENT',
      'An unguarded write must carry the grant-row predicate.',
    );
  const tables = banned();
  for (const t of writes)
    if (tables.has(t))
      throw new AuthorityError(
        'GRANT_UNGUARDED_TABLE',
        `${t} is written through the typed builder, not unguarded().`,
      );
}

// The markers read the grant row of `main`, so a CTE or alias in caller text cannot stand in for it.
const MARKERS = {
  grant: 'EXISTS (SELECT 1 FROM main.authority_grants ag WHERE ag.id = ?)',
  org: '(SELECT ag.org_id FROM main.authority_grants ag WHERE ag.id = ?)',
  mode: '(SELECT ag.mode FROM main.authority_grants ag WHERE ag.id = ?)',
  pass: '(SELECT ag.target_id FROM main.authority_grants ag WHERE ag.id = ?)',
} as const;

const form = (column: string, marker: string) =>
  new RegExp(
    `\\b(?:\\w+\\.)?${column}\\s*=\\s*\\{${marker}\\}|\\{${marker}\\}\\s*=\\s*(?:\\w+\\.)?${column}\\b`,
    'g',
  );

function lintPart(part: GrantPart, scope: GrantScope, holder: boolean): string {
  const text = assertSqlText(part.sql, 'A part');
  if (/\b(?:authority_grants|ag)\b/i.test(text))
    throw override('A part cannot name the grant table or its alias: use {grant}.');
  for (const m of text.matchAll(/\{([^}]*)\}/g))
    if (!(m[1] === 'grant' || m[1] === 'org' || m[1] === 'mode' || m[1] === 'pass'))
      throw override(`Unknown marker {${m[1]}} in a part.`);
  if (text.includes('{org}') && scope === 'platform')
    throw override('{org} needs a tenant: a platform grant has none.');
  if (text.includes('{mode}') && scope !== 'org_mode')
    throw override('{mode} needs an org_mode grant.');
  if (text.includes('{pass}') && !holder) throw override('{pass} is for holder grants.');
  if ([...text.matchAll(/\?/g)].length !== part.params.length)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'A part has the wrong number of parameters.');
  return text;
}

/** The text with the allowed tenant comparisons removed; no other org_id or mode may remain. */
function afterTenantForms(text: string): string {
  let rest = text.replace(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\([^)]*\)/gi, 'INSERT INTO t');
  rest = rest.replace(form('org_id', 'org'), ' ').replace(form('mode', 'mode'), ' ');
  rest = rest.replace(/\{(?:grant|org|mode|pass)\}/g, ' ');
  if (/\b(?:org_id|mode)\b/i.test(rest))
    throw override('A part compares org_id and mode only to {org} and {mode}.');
  return rest;
}

/** Each org-bearing table named in FROM or JOIN carries its `org_id = {org}` term. */
function lintRead(part: GrantPart, text: string, scope: GrantScope): void {
  assertReadOnly(part.sql, 'A read part');
  if (!/^\s*(?:select|with)\b/i.test(text)) throw override('A read part is a SELECT.');
  if (!text.includes('{org}') && !(scope === 'platform' && text.includes('{grant}')))
    throw override('A read part takes its tenant from {org}.');
  afterTenantForms(text);
  if (scope === 'platform') return;
  for (const m of text.matchAll(
    /\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi,
  )) {
    const table = (m[1] ?? '').toLowerCase();
    const alias =
      /^(?:where|join|left|inner|on|group|order|limit|union|cross|natural|using)$/i.test(m[2] ?? '')
        ? table
        : (m[2] ?? table);
    const t = GUARDED_TABLES[table];
    if (t && t.org !== null && t.org !== 'org_id')
      throw override(`${table} cannot be read in a part.`);
    if ((t && t.org === 'org_id') || ORG_BEARING_TABLES.has(table))
      if (
        !new RegExp(
          `\\b${alias}\\.org_id\\s*=\\s*\\{org\\}|\\{org\\}\\s*=\\s*${alias}\\.org_id\\b`,
          'i',
        ).test(text)
      )
        throw override(`${table} is read with ${alias}.org_id = {org}.`);
  }
}

function insertExpressions(text: string): { columns: string[]; rows: string[][] } | null {
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
function lintColumn(
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
  );
  if (!own.test(text)) throw override(need);
}

/** A row pinned through its transfer: the transfer row of `{pass}` is the one the write names. */
function lintTransferPin(
  kind: WriteKind,
  table: string,
  text: string,
  column: string,
  ins: ReturnType<typeof insertExpressions>,
): void {
  const need = `${table} must be tied to a transfer of {pass}.`;
  const m = /\bFROM\s+pass_credential_transfers\s+(?:AS\s+)?([a-z_]\w*)\s+WHERE\b/i.exec(text);
  const alias = m?.[1];
  if (!alias || !new RegExp(`\\b${alias}\\.pass_id\\s*=\\s*\\{pass\\}`).test(text))
    throw override(need);
  if (kind === 'insert') {
    const at = ins?.columns.indexOf(column) ?? -1;
    if (!ins || at < 0 || ins.rows.some((r) => (r[at] ?? '').trim() !== `${alias}.id`))
      throw override(need);
    return;
  }
  if (!new RegExp(`\\b${alias}\\.id\\s*=\\s*(?:${table}\\.)?${column}\\b`).test(text))
    throw override(need);
}

function lintWrite(text: string, holder: boolean): string {
  const targets = writeTargetsOf(text);
  const [target] = targets;
  if (targets.length !== 1 || !target) throw override('A write part has exactly one write target.');
  const { kind, table } = target;
  if (banned().has(table))
    throw new AuthorityError(
      'GRANT_UNGUARDED_TABLE',
      `${table} is written through the typed builder, not a part.`,
    );
  if (!text.includes('{grant}')) throw override('A write part must carry {grant}.');
  const ins = kind === 'insert' ? insertExpressions(text) : null;
  if (ORG_BEARING_TABLES.has(table) || ins?.columns.includes('org_id'))
    lintColumn(kind, table, text, 'org_id', 'org', ins);
  if (MODE_BEARING_TABLES.has(table) || ins?.columns.includes('mode'))
    lintColumn(kind, table, text, 'mode', 'mode', ins);
  if (holder) {
    const pin = HOLDER_PART_PINS[table];
    if (pin?.via === 'transfer') lintTransferPin(kind, table, text, pin.column, ins);
    else if (pin) lintColumn(kind, table, text, pin.column, 'pass', ins);
    else if (!PASS_BEARING_TABLES.has(table))
      throw override(`${table} is not written under a holder grant.`);
    else lintColumn(kind, table, text, 'pass_id', 'pass', ins);
  }
  afterTenantForms(text);
  return table;
}

/** Validates a part and expands its markers, binding the grant id at each marker's position. */
export function buildPart(
  grantId: string,
  scope: GrantScope,
  part: GrantPart,
  options: { holder?: boolean; onWrite?: (table: string) => void } = {},
): BuiltStatement {
  const holder = options.holder === true;
  const text = lintPart(part, scope, holder);
  if (part.kind === 'read') lintRead(part, text, scope);
  else options.onWrite?.(lintWrite(text, holder));
  const params: SqlValue[] = [];
  let i = 0;
  const sql = mapOutsideLiterals(part.sql, (seg) =>
    seg.replace(/\?|\{(grant|org|mode|pass)\}/g, (m, name?: keyof typeof MARKERS) => {
      if (name) {
        params.push(grantId);
        return MARKERS[name];
      }
      params.push(part.params[i++] ?? null);
      return m;
    }),
  );
  stripLiterals(sql);
  return { sql, params, ...(part.kind === 'read' ? { read: true as const } : {}) };
}
