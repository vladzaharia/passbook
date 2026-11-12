// Parts built by side builders (retention proofs, counters, history) that commit only in a grant's batch.
// A part is inert data; markers bind the grant row, and the lints below tie it to the grant's tenant.
import { AuthorityError } from './authority-error.ts';
import {
  insertExpressions,
  lintColumn,
  lintPassTie,
  lintTransferPin,
  tied,
} from './authority-part-ties.ts';
import type { GrantScope } from './authority-principal.ts';
import {
  assertPlainParams,
  assertReadOnly,
  assertSqlText,
  hasCommaJoin,
  hasConjunct,
  mapOutsideLiterals,
  openOf,
  stripLiterals,
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
  if (writes.length > 0 && !/\bauthority_grants\b/.test(stripLiterals(sql)))
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
const KNOWN_TABLES = () =>
  new Set<string>([
    ...banned(),
    ...ORG_BEARING_TABLES,
    ...MODE_BEARING_TABLES,
    ...PASS_BEARING_TABLES,
    ...Object.keys(HOLDER_PART_PINS),
  ]);

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
  assertPlainParams(text, 'A part');
  if ([...text.matchAll(/\?/g)].length !== part.params.length)
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'A part has the wrong number of parameters.');
  if (hasCommaJoin(text)) throw override('A part joins with JOIN ... ON, not a comma.');
  const tables = KNOWN_TABLES();
  for (const m of text.matchAll(
    /\b([a-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi,
  ))
    if (tables.has((m[1] ?? '').toLowerCase())) throw override(`A CTE cannot shadow ${m[1]}.`);
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
    // The term holds where the alias is defined: a subquery's own WHERE or ON, else the statement's.
    const level = openOf(text, m.index ?? 0);
    if (
      ((t && t.org === 'org_id') || ORG_BEARING_TABLES.has(table)) &&
      !tied(text, alias, 'org_id', 'org', level)
    )
      throw override(`${table} is read with ${alias}.org_id = {org} as a conjunct.`);
    if (
      scope === 'org_mode' &&
      (t?.mode || MODE_BEARING_TABLES.has(table)) &&
      !tied(text, alias, 'mode', 'mode', level)
    )
      throw override(`${table} is read with ${alias}.mode = {mode} under an org_mode grant.`);
  }
}

function lintWrite(text: string, scope: GrantScope, holder: boolean): string {
  const targets = writeTargetsOf(text);
  const [target] = targets;
  if (targets.length !== 1 || !target) throw override('A write part has exactly one write target.');
  const { kind, table } = target;
  if (banned().has(table))
    throw new AuthorityError(
      'GRANT_UNGUARDED_TABLE',
      `${table} is written through the typed builder, not a part.`,
    );
  if (!hasConjunct(text, /\{grant\}/g))
    throw override('A write part must carry {grant} as a conjunct.');
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
  } else if (scope !== 'platform' && PASS_BEARING_TABLES.has(table))
    lintPassTie(kind, table, text, scope, ins);
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
  else options.onWrite?.(lintWrite(text, scope, holder));
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
