import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import { type CheckedRow, isError } from './import-check.ts';
import { IMPORT_TEXT, type ImportProblem } from './import-messages.ts';
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parse<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

/**
 * The action of each row (design §8, steps 8-9): find live passes by External ID or Email in one batched
 * lookup per key kind, then create, update, leave alone or refuse. Reads only.
 */
export async function planRows(
  db: D1Database,
  scope: MatchScope,
  plan: ImportPlan,
  manifest: TemplateManifest,
  rows: readonly CheckedRow[],
): Promise<PlannedRow[]> {
  const keyOf = (r: CheckedRow) => (plan.match === 'email' ? r.holderEmail : r.externalId);
  const column = plan.match === 'email' ? 'holder_email' : 'external_id';
  const found = new Map<string, ExistingPass[]>();
  if (plan.match !== 'none') {
    const keys = rows.filter((r) => !r.problems.some(isError)).flatMap((r) => keyOf(r) ?? []);
    for (const p of await livePassesBy(db, scope.orgId, scope.mode, column, keys)) {
      const key = p[column];
      if (key !== null) found.set(key, [...(found.get(key) ?? []), p]);
    }
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
    const refuse = (code: string, message: string): PlannedRow => {
      r.problems.push({ row: r.row, column: null, field: null, code, message, severity: 'error' });
      return planned('error');
    };
    if (r.problems.some(isError) || r.input === null) return planned('error');
    if (plan.match === 'none') return planned('create');
    const key = keyOf(r);
    const matches = key === null ? [] : (found.get(key) ?? []);
    const [p] = matches;
    if (!p) return planned('create');
    if (matches.length > 1)
      return refuse('IMPORT_MATCH_AMBIGUOUS', IMPORT_TEXT.ambiguous(keyLabel));
    if (p.template_id !== scope.templateId)
      return refuse('IMPORT_OTHER_TEMPLATE', IMPORT_TEXT.otherTemplate);
    if (p.connection_id !== null)
      return refuse('IMPORT_CONNECTED', IMPORT_TEXT.connected(names.get(p.connection_id) ?? null));

    const warn = (code: string, field: string | null, message: string) =>
      r.problems.push({ row: r.row, column: null, field, code, message, severity: 'warning' });
    const current = parse<Personalization>(p.personalization);
    const sources = parse<Record<string, string>>(p.field_sources);
    let changed = false;
    for (const [k, v] of Object.entries(r.input)) {
      if (same(current[k] ?? defaults[k], v)) continue;
      if (sources[k] === 'manual' && !plan.overwriteManual)
        warn('IMPORT_MANUAL_KEPT', k, IMPORT_TEXT.manualKept(label(k)));
      else changed = true;
    }
    if (r.holderEmail !== null && r.holderEmail !== p.holder_email)
      warn('IMPORT_EMAIL_KEPT', 'holderEmail', IMPORT_TEXT.emailKept);
    return planned(changed ? 'update' : 'unchanged', p);
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
    warnings: rows.flatMap((r) => r.problems).filter((p: ImportProblem) => p.severity === 'warning')
      .length,
  };
}
