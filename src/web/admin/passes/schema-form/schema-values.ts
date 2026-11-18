export type FormValues = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const sortKeys = (v: FormValues): FormValues =>
  Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)));

/** Drops empty values so optional fields are omitted from the request. */
export function cleanValues(values: FormValues): FormValues {
  const out: FormValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    if (Array.isArray(value)) {
      const rows = value.map((row) => (isObject(row) ? sortKeys(cleanValues(row)) : row));
      // Empty rows keep their place so a server error at `list/1/x` maps to form row 1.
      if (rows.some((row) => !isObject(row) || Object.keys(row).length > 0)) out[key] = rows;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function sortedEntries(v: FormValues): [string, unknown][] {
  return Object.entries(cleanValues(v)).sort(([x], [y]) => (x < y ? -1 : 1));
}

export function sameValues(a: FormValues, b: FormValues): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

/** Input keys that feed `pointer` through a plain `{{key}}` binding. */
export function keysBoundTo(manifest: unknown, pointer: string): Set<string> {
  const out = new Set<string>();
  const bindings = isObject(manifest) && Array.isArray(manifest.bindings) ? manifest.bindings : [];
  for (const b of bindings) {
    if (!isObject(b) || !isObject(b.to) || b.to.pointer !== pointer) continue;
    const m = typeof b.value === 'string' ? /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(b.value) : null;
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}
