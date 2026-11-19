// Field-by-field comparison of one pass across surfaces. Pure: surfaces hand over their text.
export type Cell = 'shown' | 'partial' | 'missing' | 'omitted' | 'na' | 'unknown';
export type RowKind = 'field' | 'barcode' | 'color' | 'meta';
export type Row = { path: string; kind: RowKind; label: string; value: string };
export type Surface =
  | { kind: 'source' }
  | {
      kind: 'text';
      text: string;
      /** Row kinds this surface can show as text. */
      reads?: RowKind[];
      /** Shown for reference; a gap here is by design and does not make a row differ. */
      informational?: boolean;
    }
  | { kind: 'wallet'; text: string; items: { path: string; support: string }[] }
  | { kind: 'none' };
export type Compared = Row & { cells: Record<string, Cell>; differs: boolean };

type Json = Record<string, unknown>;
const GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
];
const STYLES = ['boardingPass', 'coupon', 'eventTicket', 'generic', 'storeCard'];
const COLORS = ['backgroundColor', 'foregroundColor', 'labelColor'] as const;

const str = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** The pass.json content that a surface is expected to carry. */
export function expectedRows(pass: Json): Row[] {
  const rows: Row[] = [];
  const style = STYLES.find((s) => typeof pass[s] === 'object' && pass[s] !== null);
  const body = (style ? pass[style] : {}) as Json;
  for (const group of GROUPS) {
    for (const f of (body[group] as Json[] | undefined) ?? []) {
      rows.push({
        path: `${group}.${str(f.key)}`,
        kind: 'field',
        label: str(f.label),
        value: str(f.value),
      });
    }
  }
  // `description` is the VoiceOver label; no surface shows it.
  for (const key of ['organizationName', 'logoText', 'expirationDate'] as const) {
    if (pass[key]) rows.push({ path: key, kind: 'meta', label: key, value: str(pass[key]) });
  }
  const barcode = ((pass.barcodes as Json[] | undefined) ?? [])[0];
  if (barcode) {
    rows.push({
      path: 'barcodes.0',
      kind: 'barcode',
      label: str(barcode.format),
      value: str(barcode.message),
    });
  }
  for (const key of COLORS) {
    if (pass[key]) rows.push({ path: key, kind: 'color', label: key, value: str(pass[key]) });
  }
  return rows;
}

export const norm = (s: string): string =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Other ways a surface may write the same value: dates, and colors as hex. */
export function variants(value: string): string[] {
  const out = [value];
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  if (rgb) {
    out.push(`#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`);
  }
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const utc = { timeZone: 'UTC' } as const;
      out.push(
        value.slice(0, 10),
        d.toLocaleDateString('en-US', { ...utc, dateStyle: 'medium' }),
        d.toLocaleDateString('en-US', { ...utc, dateStyle: 'long' }),
        d.toLocaleDateString('en-US', { ...utc, dateStyle: 'short' }),
        d.toLocaleDateString('en-GB', { ...utc, dateStyle: 'medium' }),
      );
    }
  }
  return out;
}

const has = (text: string, needle: string): boolean => needle !== '' && text.includes(norm(needle));

/** Does `text` carry this row's value (shown), only its label (partial), or neither (missing)? */
export function matchText(row: Row, text: string): Cell {
  const t = norm(text);
  if (variants(row.value).some((v) => has(t, v))) return 'shown';
  return row.kind === 'field' && has(t, row.label) ? 'partial' : 'missing';
}

function cellFor(row: Row, s: Surface): Cell {
  // A field with no value has nothing to show.
  if (row.value === '' && (s.kind === 'text' || s.kind === 'wallet')) return 'na';
  switch (s.kind) {
    case 'source':
      return 'shown';
    case 'none':
      return 'unknown';
    case 'text':
      return s.reads && !s.reads.includes(row.kind) ? 'na' : matchText(row, s.text);
    case 'wallet': {
      const item = s.items.find((i) => i.path === row.path);
      if (item?.support === 'omitted') return 'omitted';
      const found = matchText(row, s.text);
      if (found === 'shown' && item?.support === 'difference') return 'partial';
      return found;
    }
  }
}

const BAD: Cell[] = ['partial', 'missing', 'omitted'];

export function compareRows(rows: Row[], surfaces: Record<string, Surface>): Compared[] {
  return rows.map((row) => {
    const cells = Object.fromEntries(
      Object.entries(surfaces).map(([name, s]) => [name, cellFor(row, s)]),
    );
    const differs = Object.entries(cells).some(
      ([name, c]) =>
        BAD.includes(c) && !(surfaces[name] as { informational?: boolean }).informational,
    );
    return { ...row, cells, differs };
  });
}
