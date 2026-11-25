import type { Json } from '../../../shared/contracts/common.ts';
import type { FieldChange } from '../../../shared/contracts/issuing.ts';
import { fieldChanges } from '../../../shared/issuing/diff.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { resolveTemplate } from './builder.ts';
import type { ImportProblem } from './import-messages.ts';
import { splitInput } from './import-plan.ts';
import { personalizationsOf } from './repo-import-lookup.ts';
import type { ImportRowRecord } from './repo-import-rows.ts';
import type { ImportRow } from './repo-imports.ts';

function objectOf(json: string | null | undefined): Record<string, Json> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, Json>)
      : null;
  } catch {
    return null;
  }
}

/**
 * An update's changed fields in the admin's words, by row: the pass as it was (the value the commit
 * kept, else the pass now) against the mapped values. Fields kept because they were edited by hand are left out.
 */
export async function rowChanges(
  ctx: ServiceContext,
  imp: ImportRow,
  rows: readonly ImportRowRecord[],
  problemsOf: (row: ImportRowRecord) => ImportProblem[],
): Promise<Map<number, FieldChange[]>> {
  const out = new Map<number, FieldChange[]>();
  const wanted = rows.filter((r) => r.action === 'update' && r.pass_id !== null);
  if (wanted.length === 0) return out;
  let schema: unknown;
  try {
    schema = (
      await resolveTemplate(ctx, imp.org_id, imp.template_id, imp.template_version ?? undefined)
    ).manifest.inputs;
  } catch (error) {
    ctx.log.warn('pass_import.changes_unavailable', {
      code: 'IMPORT_TEMPLATE_UNRESOLVED',
      importId: imp.id,
      error,
    });
    return out;
  }
  const now = await personalizationsOf(
    ctx.env.DB,
    imp.org_id,
    wanted.flatMap((r) => r.pass_id ?? []),
  );
  const timeZone = await readOrgTimeZone(ctx.env.DB, imp.org_id);
  for (const r of wanted) {
    // The commit keeps `{ personalization, fieldSources }`; an older import kept the inputs flat.
    const stored = objectOf(r.before);
    const earlier =
      stored && typeof stored.personalization === 'object' && stored.personalization !== null
        ? (stored.personalization as Record<string, Json>)
        : stored;
    const before = earlier ?? objectOf(now.get(r.pass_id ?? ''));
    const input = r.input === null ? null : splitInput(r.input).input;
    // A finished row without its earlier values has nothing left to compare against.
    if (!before || !input || (r.state !== 'planned' && !r.before)) continue;
    const kept = new Set(
      problemsOf(r)
        .filter((p) => p.code === 'IMPORT_MANUAL_KEPT')
        .map((p) => p.field),
    );
    const changes = fieldChanges(
      schema,
      before,
      { ...before, ...input },
      timeZone ? { timeZone } : {},
    ).filter((c) => !kept.has(c.key));
    if (changes.length > 0) out.set(r.row_no, changes);
  }
  return out;
}
