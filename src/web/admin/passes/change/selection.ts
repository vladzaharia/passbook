import { z } from 'zod';
import { CHANGE_RUN_MAX_PASS_IDS } from '@/shared/contracts/broadcasts-change.ts';
import { type PassFilter, PassFilterSchema } from '@/shared/contracts/pass-selection.ts';

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
export function targetOf(selection: ChangeSelection) {
  if (selection.kind === 'ids') return { passIds: selection.ids };
  if (selection.kind === 'filter')
    return (
      filterTarget(selection.filter, selection.templateIds) ?? {
        templateIds: selection.templateIds,
      }
    );
  if (selection.kind === 'import') return { importId: selection.importId };
  return { templateIds: [selection.templateId] };
}

const FILTER_KEYS = ['onDevice', 'holderState', 'q', 'scan', 'match'] as const;

/**
 * A change run's target for a list filter: its import, or its template with the filters a run takes.
 * Null when the filter has something a run cannot read (a connection, an email, an exact ID, text
 * clauses, more than 3 clauses), or no single template to read the fields from.
 */
function filterTarget(
  filter: PassFilter,
  templateIds: readonly string[],
): Record<string, unknown> | null {
  const unsupported =
    filter.connectionId !== undefined ||
    filter.holderEmail !== undefined ||
    filter.externalId !== undefined ||
    (filter.status !== undefined && filter.status !== 'active') ||
    (filter.match !== undefined &&
      (filter.match.length > 3 || filter.match.some((c) => 'op' in c)));
  if (unsupported) return null;
  if (filter.importId !== undefined) return { importId: filter.importId };
  const id = filter.templateId ?? (templateIds.length === 1 ? templateIds[0] : undefined);
  if (id === undefined) return null;
  const kept: Record<string, unknown> = { templateIds: [id] };
  for (const key of FILTER_KEYS) if (filter[key] !== undefined) kept[key] = filter[key];
  return kept;
}

/** The selection for "Select all N matching", or null when a run cannot take this filter. */
export function filterSelection(
  filter: PassFilter,
  templateIds: readonly string[],
  count: number,
): ChangeSelection | null {
  if (filterTarget(filter, templateIds) === null || templateIds.length === 0) return null;
  return { kind: 'filter', filter, count, templateIds: [...templateIds] };
}

export function templatesOf(selection: ChangeSelection): string[] {
  return selection.kind === 'template' ? [selection.templateId] : selection.templateIds;
}

/** Operate passes and manage messages: what a change run needs from a person. */
export const canChangePasses = (capabilities: readonly string[] | undefined): boolean =>
  capabilities?.includes('passes:operate') === true && capabilities.includes('messages:manage');
