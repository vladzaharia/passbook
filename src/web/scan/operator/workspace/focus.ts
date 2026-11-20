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

/** A dialog, or a menu or listbox that has the keys (menu typeahead): the workspace's keys stand aside. */
export const dialogOpen = (): boolean =>
  document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  ) !== null;

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
export function focusHeading(): boolean {
  const pane = document.querySelector<HTMLElement>('[data-operator-record]');
  const heading = pane?.querySelector<HTMLElement>(`${HEADING_SELECTOR}, h2, h1`) ?? pane ?? null;
  if (!heading) return false;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  // Under one column the idle view is not shown, and a hidden element takes no focus.
  return document.activeElement === heading;
}

/** Nothing has focus: the control that held it is gone. */
export const focusLost = (): boolean =>
  !document.activeElement || document.activeElement === document.body;

/** Where focus returns after a record closes: its opener, else the heading, else the field. */
export function focusAfterClose(opener: string | null): void {
  const row =
    opener && opener !== 'search'
      ? document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(opener)}"] [data-roving]`)
      : null;
  if (row) row.focus();
  else if (opener === 'search') focusSearch(false);
  else if (!focusHeading()) focusSearch(false);
}

/** The key of the list row that holds focus, if one does. */
export const rowKeyOfFocus = (): string | null =>
  document.activeElement?.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null;
