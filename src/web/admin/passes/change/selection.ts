import { z } from 'zod';
import { CHANGE_RUN_MAX_PASS_IDS } from '@/shared/contracts/broadcasts-change.ts';
import { type PassFilter, PassFilterSchema } from '@/shared/contracts/pass-selection.ts';
import { CHANGE_COPY as C } from './copy.ts';

/** What a change run touches: ticked rows, one import's passes, or a whole template. */
export const ChangeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ids'),
    ids: z.array(z.string()).min(1).max(CHANGE_RUN_MAX_PASS_IDS),
    templateIds: z.array(z.string()).min(1).max(20),
  }),
  z.object({ kind: z.literal('import'), importId: z.string(), templateIds: z.array(z.string()) }),
  z.object({ kind: z.literal('template'), templateId: z.string() }),
  /** Every pass the list's filter matches (Select all N matching), with the count the person saw. */
  z.object({
    kind: z.literal('filter'),
    filter: PassFilterSchema,
    count: z.number().int().nonnegative(),
    templateIds: z.array(z.string()).min(1).max(20),
  }),
]);
export type ChangeSelection = z.infer<typeof ChangeSelectionSchema>;

const KEY = 'passbook.change-selection';

/** The rows are too many for a URL: the list leaves them here for the wizard's route to read. */
export function leaveSelection(orgId: string, selection: ChangeSelection): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ orgId, selection }));
  } catch {
    // Storage blocked: the wizard opens empty and says to pick passes again.
  }
}

/** Forget the hand-off once a run is made, so Back or a bookmark does not reopen it. */
export function clearSelection(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

export function takeSelection(orgId: string): ChangeSelection | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = z
      .object({ orgId: z.string(), selection: ChangeSelectionSchema })
      .safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.orgId === orgId ? parsed.data.selection : undefined;
  } catch {
    return undefined;
  }
}

/** The run's `target`, without `expectCount` (the review adds the count the person saw). */
export function targetOf(selection: ChangeSelection): Record<string, unknown> | null {
  if (selection.kind === 'ids') return { passIds: selection.ids };
  if (selection.kind === 'filter') return filterTarget(selection.filter);
  if (selection.kind === 'import') return { importId: selection.importId };
  return { templateIds: [selection.templateId] };
}

const FILTER_KEYS = ['onDevice', 'holderState', 'q', 'scan', 'match'] as const;

/** Why a list filter cannot be a change run, in one line; null when it can. */
export function filterRefusal(filter: PassFilter): string | null {
  if (
    filter.connectionId !== undefined ||
    filter.holderEmail !== undefined ||
    filter.externalId !== undefined
  )
    return C.hint.filter;
  if (filter.status !== undefined && filter.status !== 'active') return C.hint.status;
  if (
    filter.match !== undefined &&
    (filter.match.length > 3 || filter.match.some((c) => 'op' in c))
  )
    return C.hint.match;
  if (filter.importId === undefined && filter.templateId === undefined) return C.hint.template;
  return null;
}

/**
 * A change run's target for a list filter: its import or its template, with every other filter the
 * list had (a run never widens the list). Null when the run cannot take the filter.
 */
function filterTarget(filter: PassFilter): Record<string, unknown> | null {
  if (filterRefusal(filter) !== null) return null;
  const kept: Record<string, unknown> =
    filter.importId !== undefined
      ? { importId: filter.importId }
      : { templateIds: [filter.templateId] };
  for (const key of FILTER_KEYS) if (filter[key] !== undefined) kept[key] = filter[key];
  return kept;
}

/**
 * The selection for "Select all N matching", or null when a run cannot take this filter. The fields
 * come from the filter's template, or for an import from the template of the rows on screen.
 */
export function filterSelection(
  filter: PassFilter,
  rowTemplateIds: readonly string[],
  count: number,
): ChangeSelection | null {
  if (filterTarget(filter) === null) return null;
  const templateIds = filter.templateId !== undefined ? [filter.templateId] : [...rowTemplateIds];
  if (templateIds.length === 0) return null;
  return { kind: 'filter', filter, count, templateIds };
}

export function templatesOf(selection: ChangeSelection): string[] {
  return selection.kind === 'template' ? [selection.templateId] : selection.templateIds;
}

/** Operate passes and manage messages: what a change run needs from a person. */
export const canChangePasses = (capabilities: readonly string[] | undefined): boolean =>
  capabilities?.includes('passes:operate') === true && capabilities.includes('messages:manage');
