/**
 * The focus manager's DOM side. Zones, the field and the record heading are found by attribute,
 * so the keys hook and the components agree without sharing refs. Nothing here moves focus on
 * its own: callers do, and only for something the operator did.
 */
import type { Zone } from '../keys.ts';

export const SEARCH_SELECTOR = '[data-operator-search]';
const HEADING_SELECTOR = '[data-operator-heading]';
const NON_TEXT = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]);
const INTERACTIVE =
  'button, a[href], summary, select, [role="tab"], [role="option"], [role="menuitem"], [role="button"], [role="switch"], [role="checkbox"]';

const isTextControl = (el: Element): boolean =>
  (el instanceof HTMLInputElement && !NON_TEXT.has(el.type)) ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLElement && el.isContentEditable);

export function zoneOf(el: Element | null): Zone {
  if (!el) return 'record';
  if (el.matches(SEARCH_SELECTOR)) return 'search';
  return isTextControl(el) ? 'text' : 'record';
}

/** The target takes Enter and Space itself. */
export const isInteractive = (el: Element | null): boolean => Boolean(el?.closest(INTERACTIVE));

export const dialogOpen = (): boolean =>
  document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]') !== null;

export const searchField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(SEARCH_SELECTOR);

/** Into the field with its text selected, so the next key replaces it. */
export function focusSearch(select = true): void {
  const field = searchField();
  if (!field) return;
  field.focus();
  if (select) field.select();
}

/** The record's heading, else the record pane. Not a tab stop until focus lands on it. */
export function focusHeading(): void {
  const pane = document.querySelector<HTMLElement>('[data-operator-record]');
  const heading = pane?.querySelector<HTMLElement>(`${HEADING_SELECTOR}, h2, h1`) ?? pane ?? null;
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}
