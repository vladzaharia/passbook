import type { Json } from '@/passkit/types.ts';
import { formatValue } from '@/shared/pass-view/format.ts';

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

/** The front fields as label/value rows, values formatted by each field's date or number style. */
export function fieldRows(
  passJson: Record<string, unknown>,
  locale = navigator.language,
  now = new Date(),
): { label: string; value: string }[] {
  const style = STYLES.find((s) => passJson[s] && typeof passJson[s] === 'object');
  if (!style) return [];
  const block = passJson[style] as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  for (const group of GROUPS) {
    const list = block[group];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const spec = f as Record<string, unknown>;
      const { label, key, value } = spec;
      if (value === undefined || value === null || typeof value === 'object') continue;
      const text = formatValue(value as Json, spec, { locale, now }).text;
      rows.push({ label: sentenceCase(String(label ?? key ?? '')), value: text });
    }
  }
  return rows;
}

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const WITH_YEAR = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

/** "Updated Nov 1"; the year shows once it is not this year. */
export function updatedLine(ms: number, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return `Updated ${(sameYear ? SHORT : WITH_YEAR).format(ms)}`;
}
