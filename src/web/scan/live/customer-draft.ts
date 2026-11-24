import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveDraft } from '../../../shared/contracts/scan-draft.ts';
import { CUSTOMER_COPY } from '../../../shared/copy/scan-customer.ts';

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

/** "To pay $12.00" into its words and its figure, by the copy's own template. */
export function splitHeadline(headline: string): { label: string; value: string } {
  for (const template of [CUSTOMER_COPY.toPay, CUSTOMER_COPY.adding]) {
    const at = template.indexOf('{amount}');
    const label = (at < 0 ? template : template.slice(0, at)).trim();
    if (label && headline.startsWith(label) && headline.length > label.length)
      return { label, value: headline.slice(label.length).trim() };
  }
  return { label: '', value: headline };
}

/** Each character with its place counted from the right: a digit rolls only when its place changes. */
export function figureSlots(value: string): { char: string; slot: number }[] {
  const chars = [...value];
  return chars.map((char, i) => ({ char, slot: chars.length - i }));
}
