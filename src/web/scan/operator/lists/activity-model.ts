/** The activity list as data: one view-model per scan, and the queue that keeps a read list still. */
import type { z } from 'zod';
import type { SessionActivitySchema } from '../../../../shared/contracts/scanning-sessions.ts';
import { reasonHeadline } from '../../../../shared/copy/scan-headline.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';

export type ActivityItem = z.infer<typeof SessionActivitySchema>['items'][number];
export type Tone = 'ok' | 'out' | 'hu' | 'no' | 'undone';

export interface ActivityRowView {
  id: string;
  name: string;
  /** No pass: an unknown code. */
  unknown: boolean;
  verdict: string;
  tone: Tone;
  where: string;
  /** Entered by hand: a typed code or a picked name; the page cannot tell which. */
  manual: boolean;
  at: number;
  scanId: string | null;
  passId: string | null;
  undoable: boolean;
}

const C = OPERATOR_COPY.activity;

const fillLine = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (marker, key: string) =>
    key in values ? String(values[key]) : marker,
  );

/** The name a row shows: the holder, a group's anchor with its size, or an unknown code. */
export function nameOf(item: ActivityItem): string {
  if (!item.title) return C.unknown;
  return item.groupSize
    ? fillLine(C.group, { name: item.title, n: item.groupSize - 1 })
    : item.title;
}

export function toneOf(item: ActivityItem): Tone {
  if (item.outcome === 'undone') return 'undone';
  if (item.outcome === 'heads_up') return 'hu';
  if (item.outcome === 'refused') return 'no';
  return item.direction === 'out' ? 'out' : 'ok';
}

/** The verdict word: what happened, or the reason it did not. Reasons keep their one copy table. */
export function verdictOf(item: ActivityItem): string {
  const tone = toneOf(item);
  if (tone === 'undone') return C.undone;
  if (tone === 'ok') return C.checkedIn;
  if (tone === 'out') return C.checkedOut;
  return item.reason
    ? reasonHeadline(item.reason)
    : tone === 'hu'
      ? 'Check required'
      : 'Not accepted';
}

export function viewOf(item: ActivityItem): ActivityRowView {
  return {
    id: item.id,
    name: nameOf(item),
    unknown: item.title === null,
    verdict: verdictOf(item),
    tone: toneOf(item),
    where: item.deviceName,
    manual: item.method === 'manual',
    at: item.at,
    scanId: item.scanId,
    passId: item.passId,
    undoable: item.undoable && item.scanId !== null,
  };
}

/**
 * What a list being read shows. New scans queue behind a "3 new" pill instead of moving rows
 * under the reader's eyes; rows already shown still update in place (an undo strikes through).
 */
export function visibleRows(
  items: readonly ActivityItem[],
  shown: ReadonlySet<string>,
  hold: boolean,
): { rows: ActivityItem[]; queued: number } {
  if (!hold || shown.size === 0) return { rows: [...items], queued: 0 };
  const rows = items.filter((item) => shown.has(item.id));
  return { rows, queued: items.length - rows.length };
}
