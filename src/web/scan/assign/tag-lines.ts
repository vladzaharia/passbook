/** Words for a tag read at a door or desk that the reason table does not carry. */
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { TAG_OFFLINE } from '../machine/assign-state.ts';
import type { ScanOutcome } from '../machine/types.ts';
import type { Line } from './assign-lines.ts';
import type { TagView } from './types.ts';

/** `tagRead`: the scan that made this outcome was a tag. */
export function tagReasonLine(o: ScanOutcome, tagRead: boolean): Line | null {
  if (o.reason === TAG_OFFLINE) return { headline: SCAN_TAG_COPY.needsConnection, sub: '' };
  if (tagRead && o.kind === 'refused' && o.reason === 'not_found')
    return { ...SCAN_TAG_COPY.door.unknownTag };
  return null;
}

/** An unknown tag at a Desk offers Assign tag. */
export const isUnknownTag = (o: ScanOutcome | null, tagRead: boolean): boolean =>
  o !== null && tagRead && o.kind === 'refused' && o.reason === 'not_found';

export const firstName = (holder: string | null | undefined): string =>
  (holder ?? '').trim().split(/\s+/)[0] || 'them';

/** `Tag` or `Tag · 1 of Maya's 3 passes`. */
export function flagText(tag: TagView, holder: string | null | undefined): string {
  const n = tag.count ?? 0;
  return tag.scope === 'user' && n > 1
    ? SCAN_TAG_COPY.door.flagOfMany.replace('{name}', firstName(holder)).replace('{n}', String(n))
    : SCAN_TAG_COPY.door.flag;
}

/** None of a person's several passes let them in: the line under the refusal. */
export function noneLine(tag: TagView, holder: string | null | undefined): string | null {
  const n = tag.count ?? 0;
  return tag.scope === 'user' && n > 1
    ? SCAN_TAG_COPY.door.noneLetsIn.replace('{name}', firstName(holder)).replace('{n}', String(n))
    : null;
}
