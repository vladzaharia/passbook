const GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
];
const STYLES = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'];

const isStatus = (f: Record<string, unknown>): boolean =>
  f.key === 'status' || /^(membership )?status$/i.test(String(f.label ?? ''));

/**
 * A template's own "Status: Active" field is static text; once the pass is voided, expired or
 * removed it would sit beside the stamp and contradict it. Returns the pass with that value
 * replaced by `word`; any other value (the org's own wording) stays.
 */
export function withStatusWord<T extends Record<string, unknown>>(
  pass: T,
  word: string | null | undefined,
): T {
  if (!word) return pass;
  let out: Record<string, unknown> | null = null;
  for (const style of STYLES) {
    const block = pass[style];
    if (!block || typeof block !== 'object') continue;
    for (const group of GROUPS) {
      const list = (block as Record<string, unknown>)[group];
      if (!Array.isArray(list)) continue;
      const next = list.map((f) =>
        f &&
        typeof f === 'object' &&
        isStatus(f as Record<string, unknown>) &&
        String((f as Record<string, unknown>).value)
          .trim()
          .toLowerCase() === 'active'
          ? { ...(f as object), value: word }
          : f,
      );
      if (next.some((f, i) => f !== list[i])) {
        out ??= { ...pass };
        out[style] = { ...((out[style] ?? block) as object), [group]: next };
      }
    }
  }
  return (out ?? pass) as T;
}
