import type { ZodType } from 'zod';
import {
  ScanChipSchema,
  type ScanDisplay,
  type ScanDisplayRow,
  ScanDisplayRowSchema,
} from '../../../shared/contracts/scan-display.ts';

/** Returned for a value, element or condition that cannot be shown. */
export const DROP = Symbol('drop');

type Check = (value: unknown, key: string) => boolean;

const scalar = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fewest entries a list may keep before the element holding it is no longer valid. */
const minItems = (element: Record<string, unknown>, key: string): number =>
  key === 'items' && element.type === 'columns' ? 2 : 1;

/**
 * Drop the unusable parts of the authored document, not the display. A bad text leaf removes the
 * row, chip or list item that holds it; a bad slot (title, note) is removed; a bad condition
 * removes its element (never just the condition, which would show what it hid).
 */
export function pruneDocument(
  value: unknown,
  leaf: Check,
  condition: (cond: unknown) => boolean,
  key = '',
): unknown {
  if (scalar(value)) return leaf(value, key) ? value : DROP;
  if (Array.isArray(value)) {
    const kept = value
      .map((entry) => pruneDocument(entry, leaf, condition, key))
      .filter((entry) => entry !== DROP);
    return kept;
  }
  if (!isObject(value)) return value;
  const element = typeof value.id === 'string' && !Array.isArray(value.rows);
  const atom = 'count' in value && 'other' in value;
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name === 'when' && isObject(entry)) {
      if (!condition(entry)) return DROP;
      result[name] = entry;
      continue;
    }
    const next = pruneDocument(entry, leaf, condition, name);
    if (next === DROP) {
      if (element || atom) return DROP;
      continue;
    }
    if (Array.isArray(entry) && entry.length > 0 && Array.isArray(next)) {
      const emptied = next.length < minItems(value, name);
      if (emptied && (name === 'items' || name === 'rows')) return DROP;
    }
    result[name] = next;
  }
  return result;
}

const hasBad = (value: unknown, ok: Check, key = ''): boolean => {
  if (scalar(value)) return !ok(value, key);
  if (Array.isArray(value)) return value.some((entry) => hasBad(entry, ok, key));
  if (isObject(value))
    return Object.entries(value).some(([name, entry]) => hasBad(entry, ok, name));
  return false;
};

/**
 * Repair one rendered element: a bad slot becomes null and a bad list item is removed, if the
 * contract still accepts what is left. Otherwise the element goes.
 */
function repair<T extends object>(element: T, ok: Check, schema: ZodType<T>): T | null {
  if (!hasBad(element, ok)) return element;
  const next: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(element)) {
    if (Array.isArray(entry)) next[name] = entry.filter((item) => !hasBad(item, ok, name));
    else if (scalar(entry)) next[name] = ok(entry, name) ? entry : null;
    else if (hasBad(entry, ok, name)) return null;
    else next[name] = entry;
  }
  const parsed = schema.safeParse(next);
  return parsed.success ? parsed.data : null;
}

/**
 * The rendered display without its unsafe leaves. `generic` replaces an unsafe holder name. The
 * result is null only if what is left no longer fits the contract.
 */
export function dropUnsafeLeaves(
  display: ScanDisplay,
  ok: Check,
  generic: string,
): ScanDisplay | null {
  if (!hasBad(display, ok)) return display;
  const text = (value: string | null, key: string) =>
    value === null || ok(value, key) ? value : null;
  const holder = ok(display.identity.holder, 'holder') ? display.identity.holder : generic;
  const photo = display.identity.photo && {
    url: text(display.identity.photo.url, 'url'),
    alt: ok(display.identity.photo.alt, 'alt') ? display.identity.photo.alt : '',
  };
  const panels = display.panels.flatMap((panel) => {
    const rows = panel.rows.flatMap((row) => {
      const kept = repair(row, ok, ScanDisplayRowSchema as ZodType<ScanDisplayRow>);
      return kept ? [kept] : [];
    });
    return rows.length > 0 ? [{ ...panel, title: text(panel.title, 'title'), rows }] : [];
  });
  return {
    ...display,
    templateVersion: ok(display.templateVersion, 'templateVersion') ? display.templateVersion : '',
    variant: text(display.variant, 'variant'),
    identity: {
      holder,
      initials: ok(display.identity.initials, 'initials') ? display.identity.initials : '',
      photo,
    },
    header: {
      ...display.header,
      title: text(display.header.title, 'title'),
      meta: text(display.header.meta, 'meta'),
      chips: display.header.chips.flatMap((chip) => {
        const kept = repair(chip, ok, ScanChipSchema);
        return kept ? [kept] : [];
      }),
    },
    panels,
    notes: {
      staff: text(display.notes.staff, 'staff'),
      refused: text(display.notes.refused, 'refused'),
    },
  };
}
