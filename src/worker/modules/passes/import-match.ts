import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { Logger } from '../../platform/log.ts';
import { type CheckedRow, isError } from './import-check.ts';
import { IMPORT_TEXT, type ImportProblem, problem } from './import-messages.ts';
import type { ImportPlan } from './import-plan.ts';
import { connectionNames, type ExistingPass, livePassesBy } from './repo-import-lookup.ts';

export interface PlannedRow extends CheckedRow {
  action: 'create' | 'update' | 'unchanged' | 'error';
  passId: string | null;
  expectedVersion: number | null;
}

export interface MatchScope {
  orgId: string;
  mode: string;
  templateId: string;
}

/** The whole-input checks of a row (required inputs, cross-field rules, access): see `rowChecker`. */
export type FullCheck = (row: number, input: Personalization) => ImportProblem[];

/** Key order does not matter: `{a:1,b:2}` equals `{b:2,a:1}`. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

function parse<T>(json: string, log: Logger, passId: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    log.warn('pass_import.pass_unreadable', { code: 'IMPORT_PASS_JSON', passId, error });
    return {} as T;
  }
}

/**
 * The action of each row (design §8, steps 8-9): find live passes by External ID or Email in one batched
 * lookup per key kind, then create, update, leave alone or refuse; then run the whole-input checks on
 * what the pass would hold (a create's input, an update's existing inputs merged with the mapped values).
 * A mapped External ID that a live pass already has refuses a create whatever the match key. Reads only.
 */
export async function planRows(
  db: D1Database,
  scope: MatchScope,
  plan: ImportPlan,
  manifest: TemplateManifest,
  rows: readonly CheckedRow[],
  fullCheck: FullCheck,
  log: Logger,
): Promise<PlannedRow[]> {
  const keyOf = (r: CheckedRow) => (plan.match === 'email' ? r.holderEmail : r.externalId);
  const column = plan.match === 'email' ? 'holder_email' : 'external_id';
  const clean = rows.filter((r) => !r.problems.some(isError));
  const found = new Map<string, ExistingPass[]>();
  if (plan.match !== 'none')
    for (const p of await livePassesBy(
      db,
      scope.orgId,
      scope.mode,
      column,
      clean.flatMap((r) => keyOf(r) ?? []),
    )) {
      const key = p[column];
      if (key !== null) found.set(key, [...(found.get(key) ?? []), p]);
    }
  // Taken External IDs, for rows that may create: with the match key it is the lookup above.
  const taken = new Set<string>();
  if (plan.match !== 'externalId') {
    const ids = clean.flatMap((r) => r.externalId ?? []);
    for (const p of ids.length
      ? await livePassesBy(db, scope.orgId, scope.mode, 'external_id', ids)
      : [])
      if (p.external_id !== null) taken.add(p.external_id);
  }
  const connectionIds = [...found.values()].flat().flatMap((p) => p.connection_id ?? []);
  const names = connectionIds.length
    ? await connectionNames(db, scope.orgId, connectionIds)
    : new Map<string, string>();
  const props = (manifest.inputs.properties ?? {}) as Record<string, { title?: unknown }>;
  const defaults = applyDefaults(manifest, {});
  const label = (k: string) =>
    typeof props[k]?.title === 'string' ? (props[k].title as string) : k;
  const keyLabel = plan.match === 'email' ? 'email' : 'External ID';

  return rows.map((r): PlannedRow => {
    const planned = (action: PlannedRow['action'], p?: ExistingPass): PlannedRow => ({
      ...r,
      action,
      passId: p?.id ?? null,
      expectedVersion: p?.version ?? null,
    });
    const refuse = (code: string, message: string, field: string | null = null): PlannedRow => {
      r.problems.push(problem(r.row, { code, message, field }));
      return planned('error');
    };
    const warn = (code: string, field: string | null, message: string) =>
      r.problems.push(problem(r.row, { code, field, message, severity: 'warning' }));
    /** A create must satisfy the whole template; the full check reports what it finds. */
    const create = (input: Personalization): PlannedRow => {
      if (r.externalId !== null && taken.has(r.externalId))
        return refuse('IMPORT_KEY_TAKEN', IMPORT_TEXT.keyTaken(r.externalId), 'externalId');
      r.problems.push(...fullCheck(r.row, input));
      return planned(r.problems.some(isError) ? 'error' : 'create');
    };

    if (r.problems.some(isError) || r.input === null) return planned('error');
    const key = plan.match === 'none' ? null : keyOf(r);
    const matches = key === null ? [] : (found.get(key) ?? []);
    const [p] = matches;
    if (!p) return create(r.input);
    if (matches.length > 1)
      return refuse('IMPORT_MATCH_AMBIGUOUS', IMPORT_TEXT.ambiguous(keyLabel));
    if (p.template_id !== scope.templateId)
      return refuse('IMPORT_OTHER_TEMPLATE', IMPORT_TEXT.otherTemplate);
    if (p.connection_id !== null)
      return refuse('IMPORT_CONNECTED', IMPORT_TEXT.connected(names.get(p.connection_id) ?? null));

    const current = parse<Personalization>(p.personalization, log, p.id);
    const sources = parse<Record<string, string>>(p.field_sources, log, p.id);
    const merged: Personalization = { ...current };
    let changed = false;
    for (const [k, v] of Object.entries(r.input)) {
      if (same(current[k] ?? defaults[k], v)) continue;
      const manual = sources[k] === 'manual';
      if (manual && plan.keepManual) {
        warn('IMPORT_MANUAL_KEPT', k, IMPORT_TEXT.manualKept(label(k)));
        continue;
      }
      if (manual) warn('IMPORT_MANUAL_REPLACED', k, IMPORT_TEXT.manualReplaced(label(k)));
      merged[k] = v;
      changed = true;
    }
    if (r.holderEmail !== null && r.holderEmail !== p.holder_email)
      warn('IMPORT_EMAIL_KEPT', 'holderEmail', IMPORT_TEXT.emailKept);
    if (changed) r.problems.push(...fullCheck(r.row, merged));
    return r.problems.some(isError)
      ? planned('error')
      : planned(changed ? 'update' : 'unchanged', p);
  });
}

export interface Summary {
  rows: number;
  create: number;
  update: number;
  unchanged: number;
  errors: number;
  warnings: number;
}

export function summarize(rows: readonly PlannedRow[]): Summary {
  const n = (a: PlannedRow['action']) => rows.filter((r) => r.action === a).length;
  return {
    rows: rows.length,
    create: n('create'),
    update: n('update'),
    unchanged: n('unchanged'),
    errors: n('error'),
    warnings: rows.flatMap((r) => r.problems).filter((p) => p.severity === 'warning').length,
  };
}
