import type { Json } from '@/passkit/types.ts';
import { formatValue } from '@/shared/pass-view/format.ts';
import { formatDay, formatShortDate } from '../lib/format.ts';

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

/**
 * The front fields as label/value rows, values formatted by each field's date or number style.
 * Two fields sharing a label ("Member" for the ID and the name) read by their keys instead.
 */
export function fieldRows(
  passJson: Record<string, unknown>,
  locale = navigator.language,
  now = new Date(),
): { id: string; label: string; value: string }[] {
  const style = STYLES.find((s) => passJson[s] && typeof passJson[s] === 'object');
  if (!style) return [];
  const block = passJson[style] as Record<string, unknown>;
  const rows: { id: string; label: string; value: string }[] = [];
  for (const group of GROUPS) {
    const list = block[group];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const spec = f as Record<string, unknown>;
      const { label, key, value } = spec;
      if (value === undefined || value === null || typeof value === 'object') continue;
      const text = formatValue(value as Json, spec, { locale, now }).text;
      const id = String(key ?? label ?? rows.length);
      rows.push({ id, label: sentenceCase(String(label ?? key ?? '')), value: text });
    }
  }
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.label, (count.get(r.label) ?? 0) + 1);
  return rows.map((r) => ((count.get(r.label) ?? 0) > 1 ? { ...r, label: humanizeKey(r.id) } : r));
}

/** "Updated Nov 1"; the year shows once it is not this year. */
export function updatedLine(ms: number, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return `Updated ${(sameYear ? formatShortDate : formatDay)(ms)}`;
}
