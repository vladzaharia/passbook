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
 * The ids a filter selection names, after checking the admin's count still holds (409
 * `SELECTION_CHANGED` when it moved more than 2%). Newest first.
 */
export async function resolveFilterIds(
  ctx: ServiceContext,
  scope: { orgId: string; mode: NonNullable<PassListFilter['mode']> },
  filter: PassFilter,
  expectCount: number,
): Promise<string[]> {
  const list = listFilterOf(ctx, scope, filter);
  if (filter.match && !filter.templateId)
    await assertMatchUnambiguous(ctx, scope.orgId, scope.mode, filter.match);
  const count = list ? await countPasses(ctx.env.DB, list) : 0;
  if (!list || selectionDrifted(expectCount, count))
    throw new ConflictError(
      'The matching passes changed. Review the selection and try again.',
      'SELECTION_CHANGED',
    );
  if (count > PASS_SELECTION_MAX)
    throw new ValidationError('Too many passes match. Narrow the filter.', [], 'MATCH_TOO_BROAD');
  if (count > FILTER_RUN_MAX)
    throw new ValidationError(
      `Select at most ${FILTER_RUN_MAX} passes at a time. Narrow the filter.`,
      [],
      'SELECTION_TOO_LARGE',
    );
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listPasses(ctx.env.DB, { ...list, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && ids.length <= FILTER_RUN_MAX);
  return ids.slice(0, FILTER_RUN_MAX);
}
