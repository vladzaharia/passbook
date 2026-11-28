// Template and pass-style limits of an API key, as SQL (docs: design-api-platform section 2.3).
// A limited key's actor row carries `limit_key`; its grant row copies it. A statement on a table with a
// template dimension also requires the row's template to be in `key_templates` for that key, and a table with
// none refuses the key. A key without limits has a NULL `limit_key`, so every clause is a no-op for it.
import { GUARDED_TABLES } from './authority-tables.ts';
import type { SqlValue } from './db.ts';

/** One way a row names its template. */
export type RefPart =
  /** The row's own column holds a template id (`templates.id` for a template). */
  | { column: string }
  /** The row's own column holds a JSON array of template ids; NULL means every template, so a limited key refuses it. */
  | { list: string }
  /** The row hangs off a parent row (matched by `key`, default `id`) of a table with its own template reference. */
  | { parent: string; column: string; key?: string; nullable?: true };

/** How a row of a guarded table names its template: every part must hold. */
export type TemplateRef = RefPart | { all: readonly RefPart[] };

const direct = (column = 'template_id'): TemplateRef => ({ column });
const ofPass = (column = 'pass_id'): TemplateRef => ({ parent: 'passes', column });
const ofEndpoint: RefPart = { parent: 'webhook_endpoints', column: 'endpoint_id' };
/** The feed event a delivery or attempt is for: the endpoint's list is not enough, it may have been wider before. */
const ofEvent: RefPart = { parent: 'event_feed', column: 'event_seq', key: 'seq' };

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
  pass_notes: ofPass(),
  join_issues: ofPass(),
  join_marks: ofPass(),
  member_photos: ofPass(),
  pass_channel_copies: ofPass(),
  pass_prints: ofPass(),
  scan_presence: ofPass(),
  roll_call_marks: ofPass(),
  webhook_endpoints: { list: 'template_ids' },
  webhook_endpoint_secrets: ofEndpoint,
  // A capture follows its endpoint, as a delivery does.
  webhook_captures: ofEndpoint,
  webhook_deliveries: { all: [ofEndpoint, ofEvent] },
  // A test send has no event.
  webhook_attempts: { all: [ofEndpoint, { ...ofEvent, nullable: true }] },
};

/** Where the limited key's id is read: the grant row `g` (or `k` in an upsert's conflict test), the actor row `a`, or the read predicate's `actor_ok` row `ao`. */
export type KeyRef = 'g.limit_key' | 'k.limit_key' | 'a.limit_key' | 'ao.limit_key';

const allowed = (key: KeyRef) => `(SELECT id FROM key_templates WHERE key_id=${key})`;

export const partsOf = (ref: TemplateRef): readonly RefPart[] => ('all' in ref ? ref.all : [ref]);
export const columnOf = (part: RefPart): string => ('list' in part ? part.list : part.column);

/**
 * The condition on a template-naming expression (a column, `?` or `s.col`); a list value appears twice. Aliases carry
 * a prefix so a caller's own alias cannot shadow them; a JSON element that is not text never passes.
 */
function partBody(part: RefPart, value: string, key: KeyRef): string {
  if ('list' in part)
    return `${value} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(${value}) lk_j WHERE lk_j.type <> 'text' OR lk_j.value NOT IN ${allowed(key)})`;
  if ('parent' in part) {
    const exists = `EXISTS (SELECT 1 FROM ${part.parent} lk_x WHERE lk_x.${part.key ?? 'id'} = ${value} AND ${rowBody(part.parent, 'lk_x', key)})`;
    return part.nullable ? `(${value} IS NULL OR ${exists})` : exists;
  }
  return `${value} IN ${allowed(key)}`;
}

/** The condition on an existing row `alias` of a table that has a template reference. */
function rowBody(table: string, alias: string, key: KeyRef): string {
  const ref = TEMPLATE_REFS[table];
  if (!ref) throw new Error(`${table} has no template reference.`);
  return partsOf(ref)
    .map((part) => partBody(part, `${alias}.${columnOf(part)}`, key))
    .join(' AND ');
}

/** Whether a limited key may touch rows of `table` at all. */
export const hasTemplateRef = (table: string): boolean => table in TEMPLATE_REFS;

/**
 * Org-less children whose other parent has no template: the limit rides the one edge named here, so a limited key
 * writes them only through that edge (`joined` with `via`, `insertJoined`), which holds the pass to its templates.
 * `tag_bindings`: a tag is org-level stock, the pass it opens is what carries a template.
 */
export const CARRIED_BY_EDGE: Readonly<Record<string, string>> = { tag_bindings: 'pass_id' };

/**
 * Whether a limited key may write `table`: an org table needs its own reference; an org-less child needs one on the
 * parent of each edge it is reached through (`via` picks the one edge a joined update uses, none means every edge).
 */
export function keyMayWrite(table: string, via?: string): boolean {
  const t = GUARDED_TABLES[table];
  if (!t) return false;
  if (t.org !== null) return hasTemplateRef(table);
  const carrier = CARRIED_BY_EDGE[table];
  if (carrier !== undefined)
    return (
      (via === undefined || via === carrier) &&
      (t.edges ?? []).some((e) => e.column === carrier && hasTemplateRef(e.parent))
    );
  const edges = (t.edges ?? []).filter((e) => via === undefined || e.column === via);
  return edges.length > 0 && edges.every((e) => hasTemplateRef(e.parent));
}

/** ` AND (<key> IS NULL OR <existing row in allowed templates>)`; empty for a table with no reference (the grant refuses it). */
export function restrictRow(table: string, alias: string, key: KeyRef): string {
  return hasTemplateRef(table) ? ` AND (${key} IS NULL OR ${rowBody(table, alias, key)})` : '';
}

/**
 * The same condition for a row about to be inserted, from the expressions that name its template: a bound value or
 * a column copied from the source row. Null when the statement carries none of a part's columns (a limited key
 * cannot insert it).
 */
export function restrictInsert(
  table: string,
  columns: readonly string[],
  values: readonly SqlValue[],
  copy: Record<string, string> | undefined,
): { sql: string; params: SqlValue[] } | null {
  const ref = TEMPLATE_REFS[table];
  if (!ref) return null;
  const params: SqlValue[] = [];
  const bodies: string[] = [];
  for (const part of partsOf(ref)) {
    const at = columns.indexOf(columnOf(part));
    const source = copy?.[columnOf(part)];
    if (at < 0 && source === undefined) return null;
    const body = partBody(part, at >= 0 ? '?' : `s.${source}`, 'g.limit_key');
    bodies.push(body);
    if (at >= 0)
      for (let i = body.split('?').length - 1; i > 0; i--) params.push(values[at] ?? null);
  }
  return { sql: ` AND (g.limit_key IS NULL OR ${bodies.join(' AND ')})`, params };
}

/** Columns that name a template, pass, endpoint or event: a limited key may not point one somewhere unchecked. */
const REFERENCE_COLUMNS = new Set([
  'template_id',
  'template_ids',
  'pass_id',
  'endpoint_id',
  'event_seq',
]);

/**
 * What a limited key's write that assigns columns must also satisfy. A column of the table's own template reference
 * may be set to a plain value, which must be one of the key's templates (the row would otherwise move out of reach, or
 * to every template). Any other reference column, a computed value, or a copy from the old row cannot be checked:
 * `refuse` is true and the grant denies the key. `checks` carry the value to test per part column.
 */
export function setRestriction(
  table: string,
  assigned: {
    set?: Record<string, unknown>;
    inc?: readonly string[];
    update?: readonly string[];
    copy?: Record<string, string>;
  },
): { refuse: boolean; checks: { part: RefPart; value: SqlValue }[] } {
  const own = new Map(partsOf(TEMPLATE_REFS[table] ?? { all: [] }).map((p) => [columnOf(p), p]));
  const checks: { part: RefPart; value: SqlValue }[] = [];
  let refuse = false;
  const plain = (v: unknown): v is SqlValue =>
    !(typeof v === 'object' && v !== null && !(v instanceof Uint8Array));
  for (const [column, value] of Object.entries(assigned.set ?? {})) {
    const part = own.get(column);
    if (part && plain(value)) checks.push({ part, value });
    else if (REFERENCE_COLUMNS.has(column)) refuse = true;
  }
  const others = [
    ...(assigned.inc ?? []),
    ...Object.keys(assigned.copy ?? {}),
    ...(assigned.update ?? []).filter((c) => !own.has(c)),
  ];
  // `update` assigns the inserted value, which the insert's own condition already checked, but only for the template columns.
  if (others.some((column) => REFERENCE_COLUMNS.has(column))) refuse = true;
  return { refuse, checks };
}

/** The `EXISTS` over the grant row `k` that holds a key's new value for a template column; empty when none is assigned. */
export function restrictAssigned(
  grantId: string,
  checks: readonly { part: RefPart; value: SqlValue }[],
): { sql: string; params: SqlValue[] } {
  if (checks.length === 0) return { sql: '', params: [] };
  const params: SqlValue[] = [grantId];
  const bodies = checks.map(({ part, value }) => {
    const body = partBody(part, '?', 'k.limit_key');
    for (let i = body.split('?').length - 1; i > 0; i--) params.push(value);
    return body;
  });
  return {
    sql: `EXISTS (SELECT 1 FROM authority_grants k WHERE k.id = ? AND (k.limit_key IS NULL OR ${bodies.join(' AND ')}))`,
    params,
  };
}

/** `keyMayWrite` for an insert or update of `table`, and the source table an insert copies from, if any. */
export const keyMayRow = (table: string, from?: { table: string }): boolean =>
  keyMayWrite(table.toLowerCase()) && (!from || hasTemplateRef(from.table.toLowerCase()));

/** `keyMayWrite` for `joined()`: the edge it reaches the parent by, the first when none is named. */
export const keyMayJoin = (table: string, via?: string): boolean =>
  keyMayWrite(table.toLowerCase(), via ?? GUARDED_TABLES[table.toLowerCase()]?.edges?.[0]?.column);

/** What a keyed update assigns: the template-column test (placed before the grant test) and whether the key is refused. */
export function keyedSet(
  grantId: string,
  table: string,
  assigned: Parameters<typeof setRestriction>[1],
  keyed: boolean,
): { sql: string; params: SqlValue[]; refuse: boolean } {
  if (!keyed) return { sql: '', params: [], refuse: false };
  const limit = setRestriction(table, assigned);
  return { ...restrictAssigned(grantId, limit.checks), refuse: limit.refuse };
}

/** An insert's template test, or a refusal (and a statement that cannot match) when it carries no template column. */
export function keyedInsert(
  table: string,
  columns: readonly string[],
  values: readonly SqlValue[],
  copy: Record<string, string> | undefined,
  keyed: boolean,
): { sql: string; params: SqlValue[]; refuse: boolean } {
  if (!keyed) return { sql: '', params: [], refuse: false };
  const limit = restrictInsert(table, columns, values, copy);
  return limit
    ? { ...limit, refuse: false }
    : { sql: ' AND g.limit_key IS NULL', params: [], refuse: true };
}
