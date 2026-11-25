import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveDraft } from '../../../shared/contracts/scan-draft.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';

/** A draft older than this is a read the desk walked away from. The desk sends the open one again every 15 s. */
export const DRAFT_HOLD_MS = 20_000;

export interface CustomerDraft {
  ref: string;
  at: number;
  scannerId: string;
  /** The ready card's time: a later row from the desk ends the draft. */
  readyAt: number;
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
      readyAt: message.readyAt,
      view: message.customer,
    });
  return next;
}

/** Any later row from the desk (a result, or the next read's ready card) ends its draft. */
export function settledDrafts(
  drafts: Drafts,
  rows: readonly Pick<ScanLiveRow, 'id' | 'scannerId' | 'at'>[],
): Drafts {
  const next = new Map(
    [...drafts].filter(
      ([, d]) =>
        !rows.some(
          (row) => row.scannerId === d.scannerId && row.id !== d.ref && row.at >= d.readyAt,
        ),
    ),
  );
  return next.size === drafts.size ? drafts : next;
}

/**
 * The draft that shows: the newest fresh one, over its own ready card, or over a row that is not a
 * ready card and is older than the read (an idle screen, a session that hides the desk card).
 */
export function shownDraft(
  drafts: Drafts,
  latest: Pick<ScanLiveRow, 'id' | 'at' | 'kind'> | undefined,
  now: number,
): CustomerDraft | null {
  let best: CustomerDraft | null = null;
  for (const draft of drafts.values()) {
    if (now - draft.at >= DRAFT_HOLD_MS) continue;
    if (
      latest &&
      latest.id !== draft.ref &&
      (latest.kind === 'ready' || latest.at >= draft.readyAt)
    )
      continue;
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
