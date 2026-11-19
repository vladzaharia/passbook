const STYLES = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'];
const GROUPS = ['headerFields', 'secondaryFields', 'auxiliaryFields'];
const SKIP = /status|name|holder|member ?id|^id$|since|expir/i;

/**
 * "Tier: Plus": the first plain front field that is not the holder, an id, a date or the state.
 * Passes of one holder share a title; this line tells them apart on a list.
 */
export function distinguishingLine(pass: Record<string, unknown>, title?: string): string | null {
  for (const style of STYLES) {
    const block = pass[style];
    if (!block || typeof block !== 'object') continue;
    for (const group of GROUPS) {
      const list = (block as Record<string, unknown>)[group];
      if (!Array.isArray(list)) continue;
      for (const f of list as Record<string, unknown>[]) {
        const { key, label, value } = f ?? {};
        if (typeof value !== 'string' || !value.trim() || value === title) continue;
        if (typeof label !== 'string' || !label || f?.dateStyle || f?.timeStyle) continue;
        if (SKIP.test(`${String(key)} ${label}`) || value.length > 40) continue;
        return `${label}: ${value}`;
      }
    }
  }
  return null;
}
