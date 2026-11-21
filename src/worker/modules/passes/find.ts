import type { PassMatch } from '../../../shared/contracts/broadcasts.ts';
import {
  FILTER_RUN_MAX,
  PASS_SELECTION_MAX,
  type PassFilter,
  selectionDrifted,
} from '../../../shared/contracts/pass-selection.ts';
import { strictEmail } from '../../../shared/email.ts';
import { inputFields } from '../../../shared/issuing/fields.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getVersion, latestVersionName } from '../templates/repo.ts';
import { countPasses, listPasses, orgTemplateIds, type PassListFilter } from './repo-list.ts';

const PAGE = 200;

/** The list's filters as the repo reads them; false when the filter can match nothing. */
export function listFilterOf(
  ctx: ServiceContext,
  scope: { orgId: string | null; mode: PassListFilter['mode'] },
  f: PassFilter,
): PassListFilter | false {
  const holderEmail = f.holderEmail ? strictEmail(f.holderEmail) : undefined;
  if (f.holderEmail && !holderEmail) return false;
  if (f.scan && 'eventId' in f.scan)
    throw new ValidationError('Use noScanDays.', [{ path: 'scan', message: 'Unsupported.' }]);
  return {
    orgId: scope.orgId,
    ...(scope.mode ? { mode: scope.mode } : {}),
    ...(f.templateId ? { templateId: f.templateId } : {}),
    ...(f.connectionId ? { connectionId: f.connectionId } : {}),
    ...(f.importId ? { importId: f.importId } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(holderEmail ? { holderEmail } : {}),
    ...(f.holderState ? { holderState: f.holderState } : {}),
    ...(f.onDevice !== undefined ? { onDevice: f.onDevice } : {}),
    ...(f.scan && 'noScanDays' in f.scan
      ? { noScanSince: ctx.clock.now() - f.scan.noScanDays * 86_400_000 }
      : {}),
    ...(f.match ? { match: f.match } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(f.externalId ? { externalId: f.externalId } : {}),
    limit: PAGE,
  };
}

const kindOf = (type: string): string => (type === 'integer' ? 'number' : type);

/**
 * A match without a template reads the key in every template of the org: refused when the templates
 * give it different types, since the clause would mean different things on different passes.
 */
export async function assertMatchUnambiguous(
  ctx: ServiceContext,
  orgId: string,
  mode: NonNullable<PassListFilter['mode']>,
  match: PassMatch,
): Promise<void> {
  const templateIds = await orgTemplateIds(ctx.env.DB, orgId, mode);
  const kinds = new Map<string, Set<string>>();
  for (const template_id of templateIds) {
    const name = await latestVersionName(ctx.env.DB, template_id);
    const version = name ? await getVersion(ctx.env.DB, template_id, name) : null;
    for (const field of inputFields(version?.manifest.inputs))
      if (match.some((c) => c.input === field.key))
        kinds.set(field.key, (kinds.get(field.key) ?? new Set()).add(kindOf(field.type)));
  }
  for (const [key, set] of kinds)
    if (set.size > 1)
      throw new ValidationError(
        `${key} has different types in your templates. Pick a template.`,
        [{ path: 'match', message: `${key} is ${[...set].join(' and ')}.` }],
        'MATCH_AMBIGUOUS_FIELD',
      );
}

/**
 * The passes a filter selection names (id and version), after checking the admin's count still holds:
 * any difference answers 409 `SELECTION_CHANGED` with the new number. Newest first. `inline` refuses
 * more than the inline limit (`SELECTION_USE_RUN`: start a bulk run instead).
 */
export async function resolveFilterPasses(
  ctx: ServiceContext,
  scope: { orgId: string; mode: NonNullable<PassListFilter['mode']> },
  filter: PassFilter,
  expectCount: number,
  inline: boolean,
): Promise<{ id: string; version: number }[]> {
  const list = listFilterOf(ctx, scope, filter);
  if (filter.match && !filter.templateId)
    await assertMatchUnambiguous(ctx, scope.orgId, scope.mode, filter.match);
  const count = list ? await countPasses(ctx.env.DB, list) : 0;
  const changed = (n: number) =>
    new ConflictError(`The selection changed to ${n}. Check and try again.`, 'SELECTION_CHANGED');
  if (!list || selectionDrifted(expectCount, count)) throw changed(count);
  if (count > PASS_SELECTION_MAX)
    throw new ValidationError('Too many passes match. Narrow the filter.', [], 'MATCH_TOO_BROAD');
  if (inline && count > FILTER_RUN_MAX)
    throw new ValidationError(
      `More than ${FILTER_RUN_MAX} passes match. Start a bulk run instead.`,
      [],
      'SELECTION_USE_RUN',
    );
  const out: { id: string; version: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await listPasses(ctx.env.DB, { ...list, ...(cursor ? { cursor } : {}) });
    for (const p of page.items) out.push({ id: p.id, version: p.version });
    cursor = page.nextCursor ?? undefined;
  } while (cursor && out.length <= PASS_SELECTION_MAX);
  // Passes came or went while the list was read: the same refusal as a changed count.
  if (selectionDrifted(expectCount, out.length)) throw changed(out.length);
  return out;
}
