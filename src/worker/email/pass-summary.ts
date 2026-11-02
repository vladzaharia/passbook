import type { Json } from '../../passkit/types.ts';
import { resolveColors } from '../../shared/pass-view/color.ts';
import { formatValue } from '../../shared/pass-view/format.ts';

export interface PassSummary {
  /** Up to four label/value pairs from the front, formatted like the card (the email shows three). */
  fields: { label: string; value: string }[];
  /** The pass's own colours (pass art: real colours, not tokens). */
  colors: { background: string; foreground: string; label: string };
}

const STYLES = ['eventTicket', 'boardingPass', 'storeCard', 'coupon', 'generic', 'posterGeneric'];
const GROUPS = ['primaryFields', 'secondaryFields', 'auxiliaryFields', 'headerFields'];
// Date and time live in the header on tickets and boarding passes; the email leads with them.
const HEADER_FIRST = ['eventTicket', 'boardingPass'];
const HEADER_FIRST_GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields'];
// One spare: the email drops a field that repeats the pass title.
const MAX_FIELDS = 4;

/** What the pass email shows before the badge: the pass's key fields in its colours. */
export function passSummary(
  passJson: Record<string, unknown>,
  ctx: { locale?: string; now: Date; timeZone?: string },
): PassSummary {
  const style = STYLES.find((s) => passJson[s] && typeof passJson[s] === 'object');
  const block = (style ? passJson[style] : {}) as Record<string, unknown>;
  const fields: PassSummary['fields'] = [];
  for (const group of style && HEADER_FIRST.includes(style) ? HEADER_FIRST_GROUPS : GROUPS) {
    const list = block[group];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (fields.length >= MAX_FIELDS) break;
      if (!f || typeof f !== 'object') continue;
      const spec = f as Record<string, unknown>;
      const value = spec.value;
      if (value === undefined || value === null || typeof value === 'object') continue;
      const text = formatValue(value as Json, spec, {
        locale: ctx.locale ?? 'en',
        now: ctx.now,
        ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
      }).text;
      const label = typeof spec.label === 'string' ? spec.label : '';
      if (text) fields.push({ label, value: text });
    }
  }
  const c = resolveColors(passJson);
  return { fields, colors: { background: c.background, foreground: c.foreground, label: c.label } };
}
