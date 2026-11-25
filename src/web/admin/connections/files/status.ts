import type { z } from 'zod';
import type { ConnectionFileRevisionSchema } from '@/shared/contracts/connection-files.ts';

export type Revision = z.infer<typeof ConnectionFileRevisionSchema>;
type Tone = 'neutral' | 'success' | 'info' | 'warning';

/** One word per state a revision can be in; a run that a newer one replaced reads as the run label does. */
export function statusOf(r: Revision): { label: string; tone: Tone } {
  switch (r.state) {
    case 'pending':
      return { label: 'Not applied', tone: 'info' };
    case 'current':
      return r.applied
        ? { label: 'Applied', tone: 'success' }
        : { label: 'Applying', tone: 'info' };
    case 'superseded':
      return r.applied
        ? { label: 'Replaced', tone: 'neutral' }
        : { label: 'Replaced by a newer run', tone: 'neutral' };
    case 'discarded':
      return { label: 'Discarded', tone: 'neutral' };
    default:
      return { label: 'Expired', tone: 'warning' };
  }
}

/** `+12 · 30 changed · 3 removed`, or null for revision 1. */
export function diffLine(r: Revision): string | null {
  if (!r.diff) return null;
  return `+${r.diff.added} new · ${r.diff.changed} changed · ${r.diff.removed} removed`;
}
