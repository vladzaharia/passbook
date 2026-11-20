// Template and pass-style limits of an API key, as SQL (docs: design-api-platform section 2.3).
// A limited key's actor row carries `limit_key`; its grant row copies it. A statement on a table with a
// template dimension also requires the row's template to be in `key_templates` for that key, and a table with
// none refuses the key. A key without limits has a NULL `limit_key`, so every clause is a no-op for it.
import { GUARDED_TABLES } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

/** How a row of a guarded table names its template. */
export type TemplateRef =
  /** The row's own column holds a template id (`templates.id` for a template). */
  | { column: string }
  /** The row's own column holds a JSON array of template ids; NULL means every template, so a limited key refuses it. */
  | { list: string }
  /** The row hangs off a parent row (matched by `id`) of a table with its own template reference. */
  | { parent: string; column: string };

const direct = (column = 'template_id'): TemplateRef => ({ column });
const ofPass = (column = 'pass_id'): TemplateRef => ({ parent: 'passes', column });
const ofEndpoint: TemplateRef = { parent: 'webhook_endpoints', column: 'endpoint_id' };

/**
 * Guarded tables a limited key may write or read, by how they name a template. A guarded table absent here is
 * refused to a limited key (writes: `authority_denied:actor`; reads: no rows), so a new table is safe by default.
 * An org-less child is covered through its edges: it is writable when every parent it is reached through is here.
 */
export const TEMPLATE_REFS: Readonly<Record<string, TemplateRef>> = {
  passes: direct(),
  templates: direct('id'),
  template_candidates: direct(),
  template_releases: direct(),
  template_forks: direct(),
  template_fork_updates: direct(),
  pass_imports: direct(),
  pass_import_mappings: direct(),
  join_links: direct(),
  template_channel_policies: direct(),
  pass_channels: direct(),
  channel_apply_runs: direct(),
  pass_issuance_deliveries: direct(),
  scans: direct(),
  scan_gates: direct(),
  event_feed: direct(),
  pass_credential_transfers: ofPass(),
  pass_credential_tombstones: ofPass(),
  scan_code_rotations: ofPass(),
  outbox: ofPass(),
  pass_events: ofPass(),
  join_issues: ofPass(),
  join_marks: ofPass(),
  member_photos: ofPass(),
  pass_channel_copies: ofPass(),
  pass_prints: ofPass(),
  scan_presence: ofPass(),
  roll_call_marks: ofPass(),
  webhook_endpoints: { list: 'template_ids' },
  webhook_endpoint_secrets: ofEndpoint,
  webhook_deliveries: ofEndpoint,
  webhook_attempts: ofEndpoint,
};

/** Where the limited key's id is read: the grant row `g` (or `k` in an upsert's conflict test), the actor row `a`, or the read predicate's `actor_ok`. */
export type KeyRef =
  | 'g.limit_key'
  | 'k.limit_key'
  | 'a.limit_key'
  | '(SELECT limit_key FROM actor_ok)';

const allowed = (key: KeyRef) => `(SELECT id FROM key_templates WHERE key_id=${key})`;

const columnOf = (ref: TemplateRef): string => ('list' in ref ? ref.list : ref.column);

/** The condition on a template-naming expression (a column, `?` or `s.col`); a list value appears twice. */
function valueBody(ref: TemplateRef, value: string, key: KeyRef): string {
  if ('list' in ref)
    return `${value} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(${value}) j WHERE j.value NOT IN ${allowed(key)})`;
  if ('parent' in ref)
    return `EXISTS (SELECT 1 FROM ${ref.parent} x WHERE x.id = ${value} AND ${rowBody(ref.parent, 'x', key)})`;
  return `${value} IN ${allowed(key)}`;
}

/** The condition on an existing row `alias` of a table that has a template reference. */
function rowBody(table: string, alias: string, key: KeyRef): string {
  const ref = TEMPLATE_REFS[table];
  if (!ref) throw new Error(`${table} has no template reference.`);
  return valueBody(ref, `${alias}.${columnOf(ref)}`, key);
}

/** Whether a limited key may touch rows of `table` at all. */
export const hasTemplateRef = (table: string): boolean => table in TEMPLATE_REFS;

/**
 * Whether a limited key may write `table`: an org table needs its own reference; an org-less child needs one on the
 * parent of each edge it is reached through (`via` picks the one edge a joined update uses, none means every edge).
 */
export function keyMayWrite(table: string, via?: string): boolean {
  const t = GUARDED_TABLES[table];
  if (!t) return false;
  if (t.org !== null) return hasTemplateRef(table);
  const edges = (t.edges ?? []).filter((e) => via === undefined || e.column === via);
  return edges.length > 0 && edges.every((e) => hasTemplateRef(e.parent));
}

/** ` AND (<key> IS NULL OR <existing row in allowed templates>)`; empty for a table with no reference (the grant refuses it). */
export function restrictRow(table: string, alias: string, key: KeyRef): string {
  return hasTemplateRef(table) ? ` AND (${key} IS NULL OR ${rowBody(table, alias, key)})` : '';
}

/**
 * The same condition for a row about to be inserted, from the expression that names its template: a bound value
 * or a column copied from the source row. Null when the statement carries neither (a limited key cannot insert it).
 */
export function restrictInsert(
  table: string,
  columns: readonly string[],
  values: readonly SqlValue[],
  copy: Record<string, string> | undefined,
): { sql: string; params: SqlValue[] } | null {
  const ref = TEMPLATE_REFS[table];
  if (!ref) return null;
  const at = columns.indexOf(columnOf(ref));
  const source = copy?.[columnOf(ref)];
  if (at < 0 && source === undefined) return null;
  const body = valueBody(ref, at >= 0 ? '?' : `s.${source}`, 'g.limit_key');
  const holes = at >= 0 ? body.split('?').length - 1 : 0;
  return {
    sql: ` AND (g.limit_key IS NULL OR ${body})`,
    params: Array.from({ length: holes }, () => values[at] ?? null),
  };
}

/** `keyMayWrite` for an insert or update of `table`, and the source table an insert copies from, if any. */
export const keyMayRow = (table: string, from?: { table: string }): boolean =>
  keyMayWrite(table.toLowerCase()) && (!from || hasTemplateRef(from.table.toLowerCase()));

/** `keyMayWrite` for `joined()`: the edge it reaches the parent by, the first when none is named. */
export const keyMayJoin = (table: string, via?: string): boolean =>
  keyMayWrite(table.toLowerCase(), via ?? GUARDED_TABLES[table.toLowerCase()]?.edges?.[0]?.column);
