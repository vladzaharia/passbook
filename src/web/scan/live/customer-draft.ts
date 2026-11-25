import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveDraft } from '../../../shared/contracts/scan-draft.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';

/** A draft older than this is a read the desk walked away from. The desk sends the open one again every 15 s. */
export const DRAFT_HOLD_MS = 20_000;

export interface CustomerDraft {
  ref: string;
  at: number;
  scannerId: string;
  view: ScanCustomerView;
}

export type Drafts = ReadonlyMap<string, CustomerDraft>;

/** One draft per ref, so two desks on one screen never overwrite each other. Stale ones are pruned. */
export function nextDrafts(previous: Drafts, message: ScanLiveDraft, now: number): Drafts {
  const next = new Map([...previous].filter(([, draft]) => now - draft.at < DRAFT_HOLD_MS));
  if ('cancelled' in message) {
    next.delete(message.ref);
    return next;
  }
  const held = next.get(message.ref);
  if (!held || held.at < message.at)
    next.set(message.ref, {
      ref: message.ref,
      at: message.at,
      scannerId: message.scannerId,
      view: message.customer,
    });
  return next;
}

/** A result of a desk ends its drafts: the read they were for is over, whatever the ready card did. */
export function settledDrafts(
  drafts: Drafts,
  rows: readonly Pick<ScanLiveRow, 'kind' | 'scannerId' | 'at'>[],
): Drafts {
  const ended = rows.filter((row) => row.kind !== 'ready');
  const next = new Map(
    [...drafts].filter(
      ([, d]) => !ended.some((row) => row.scannerId === d.scannerId && row.at >= d.at),
    ),
  );
  return next.size === drafts.size ? drafts : next;
}

/**
 * The draft that shows: the newest fresh one, over the ready card it belongs to, or over anything
 * older than it (an idle screen, or a session that hides the desk card). A later result wins.
 */
export function shownDraft(
  drafts: Drafts,
  latest: Pick<ScanLiveRow, 'id' | 'at'> | undefined,
  now: number,
): CustomerDraft | null {
  let best: CustomerDraft | null = null;
  for (const draft of drafts.values()) {
    if (now - draft.at >= DRAFT_HOLD_MS) continue;
    if (latest && draft.ref !== latest.id && draft.at < latest.at) continue;
    if (!best || draft.at > best.at) best = draft;
  }
  return best;
}

/** The words and the figure of a review body ("To pay", "$12.00"); none when the view carries no figure. */
export function reviewAmount(view: ScanCustomerView): { label: string; value: string } | undefined {
  return view.figure ? { label: view.band.headline, value: view.figure } : undefined;
}

/** Each character with its place counted from the right: a digit rolls only when its place changes. */
export function figureSlots(value: string): { char: string; slot: number }[] {
  const chars = [...value];
  return chars.map((char, i) => ({ char, slot: chars.length - i }));
}

/** A ready card a later result from the same scanner has replaced: it must not come back when the result expires. */
export function withoutReplacedReady(rows: readonly ScanLiveRow[]): ScanLiveRow[] {
  const settled = new Map<string, number>();
  for (const row of rows)
    if (row.kind !== 'ready')
      settled.set(row.scannerId, Math.max(settled.get(row.scannerId) ?? 0, row.at));
  return rows.filter((row) => row.kind !== 'ready' || (settled.get(row.scannerId) ?? 0) < row.at);
}
