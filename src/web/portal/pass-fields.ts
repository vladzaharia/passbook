import type { Json } from '@/passkit/types.ts';
import { formatValue } from '@/shared/pass-view/format.ts';
import { formatDay, formatExpiry, formatShortDate } from '../lib/format.ts';

const ABBREVIATIONS = new Set(['ID', 'VIP', 'URL', 'QR', 'SKU', 'ZIP', 'PIN', 'UPC', 'ETA', 'DOB']);
const STYLES = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'];
const GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields'];

/** Pass labels are often written in capitals for the card; show them as a sentence. */
export function sentenceCase(label: string): string {
  if (label.length < 2 || label !== label.toUpperCase()) return label;
  return label
    .split(' ')
    .map((w, i) => {
      if (ABBREVIATIONS.has(w)) return w;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** "memberId" -> "Member ID". */
function humanizeKey(key: string): string {
  const words = key
    .replace(/-poster$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return words
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ABBREVIATIONS.has(upper)) return upper;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

type Row = { id: string; label: string; value: string };

function groupRows(
  block: Record<string, unknown>,
  groups: readonly string[],
  ctx: { locale: string; now: Date; timeZone?: string },
): Row[] {
  const rows: Row[] = [];
  for (const group of groups) {
    const list = block[group];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const spec = f as Record<string, unknown>;
      const { label, key, value } = spec;
      if (value === undefined || value === null || typeof value === 'object') continue;
      const text = formatValue(value as Json, spec, ctx).text;
      if (!text.trim()) continue;
      const id = String(key ?? label ?? rows.length);
      rows.push({ id, label: sentenceCase(String(label ?? humanizeKey(id))), value: text });
    }
  }
  return rows;
}

/**
 * Label/value rows, values formatted by each field's date or number style: the front fields, or
 * the back's (the org's notes left out, noteRows has them). Expires follows unless a field on
 * either side already says it. Two fields sharing a label read by their keys instead.
 */
export function fieldRows(
  passJson: Record<string, unknown>,
  { locale, now, timeZone }: { locale: string; now: Date; timeZone?: string },
  side: 'front' | 'back' = 'front',
): Row[] {
  const style = STYLES.find((s) => passJson[s] && typeof passJson[s] === 'object');
  if (!style) return [];
  const block = passJson[style] as Record<string, unknown>;
  const ctx = { locale, now, ...(timeZone ? { timeZone } : {}) };
  const front = groupRows(block, GROUPS, ctx);
  const back = groupRows(block, ['backFields'], ctx).filter((r) => !NOTE_KEYS.test(r.id));
  const rows = side === 'front' ? front : back;
  const expires = passJson.expirationDate;
  // A pass that already lists its own Expires field says it once.
  const listed = [...front, ...back].some((r) => /expir/i.test(`${r.id} ${r.label}`));
  if (typeof expires === 'string' && expires && !listed) {
    const text = formatExpiry(expires, timeZone);
    if (text) rows.push({ id: 'expirationDate', label: 'Expires', value: text });
  }
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.label, (count.get(r.label) ?? 0) + 1);
  return rows.map((r) => ((count.get(r.label) ?? 0) > 1 ? { ...r, label: humanizeKey(r.id) } : r));
}

const NOTE_KEYS = /^(message|note|notes)$/i;

/**
 * What the org wrote to the holder, from the back of the pass: its latest message first, then its
 * note. Plain text only; an empty field is not a note.
 */
export function noteRows(
  passJson: Record<string, unknown>,
): { id: string; label: string; value: string }[] {
  const style = STYLES.find((s) => passJson[s] && typeof passJson[s] === 'object');
  const list = style ? (passJson[style] as Record<string, unknown>).backFields : null;
  if (!Array.isArray(list)) return [];
  const rows = list.flatMap((f: Record<string, unknown> | null) => {
    const value = typeof f?.value === 'string' ? f.value.trim() : '';
    const key = String(f?.key ?? '');
    if (!value || !NOTE_KEYS.test(key)) return [];
    return [{ id: key, label: sentenceCase(String(f?.label ?? humanizeKey(key))), value }];
  });
  return rows.sort((a, b) => Number(/^message$/i.test(b.id)) - Number(/^message$/i.test(a.id)));
}

/** "Updated Nov 1"; the year shows once it is not this year. */
export function updatedLine(ms: number, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return `Updated ${(sameYear ? formatShortDate : formatDay)(ms)}`;
}
