import { z } from 'zod';
import { CHANGE_RUN_MAX_PASS_IDS } from '@/shared/contracts/broadcasts-change.ts';

/** What a change run touches: ticked rows, one import's passes, or a whole template. */
export const ChangeSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ids'),
    ids: z.array(z.string()).min(1).max(CHANGE_RUN_MAX_PASS_IDS),
    templateIds: z.array(z.string()).min(1).max(20),
  }),
  z.object({ kind: z.literal('import'), importId: z.string(), templateIds: z.array(z.string()) }),
  z.object({ kind: z.literal('template'), templateId: z.string() }),
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
  if (selection.kind === 'import') return { importId: selection.importId };
  return { templateIds: [selection.templateId] };
}

export function templatesOf(selection: ChangeSelection): string[] {
  return selection.kind === 'template' ? [selection.templateId] : selection.templateIds;
}

/** Operate passes and manage messages: what a change run needs from a person. */
export const canChangePasses = (capabilities: readonly string[] | undefined): boolean =>
  capabilities?.includes('passes:operate') === true && capabilities.includes('messages:manage');
