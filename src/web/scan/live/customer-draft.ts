import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveDraft } from '../../../shared/contracts/scan-draft.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';

/** A draft older than this is a read the desk walked away from. */
export const DRAFT_HOLD_MS = 60_000;

export interface CustomerDraft {
  ref: string;
  at: number;
  view: ScanCustomerView;
}

/** The latest draft per ref wins; a cancel drops it. */
export function nextDraft(
  previous: CustomerDraft | null,
  message: ScanLiveDraft,
): CustomerDraft | null {
  if ('cancelled' in message) return previous?.ref === message.ref ? null : previous;
  if (previous?.ref === message.ref && previous.at >= message.at) return previous;
  return { ref: message.ref, at: message.at, view: message.customer };
}

/** The draft that shows now: for the card on screen, not older than a minute. */
export function liveDraft(
  draft: CustomerDraft | null,
  shownRef: string | undefined,
  now: number,
): CustomerDraft | null {
  if (!draft || draft.ref !== shownRef || now - draft.at >= DRAFT_HOLD_MS) return null;
  return draft;
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
