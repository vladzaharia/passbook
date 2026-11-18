export const BOM = String.fromCharCode(0xfeff);

/** A leading =, +, - or @ makes spreadsheets run the cell as a formula: prefix a quote. */
export function guardCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** RFC 4180 CSV: quotes fields with delimiters, quotes or line breaks; CRLF rows. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => {
    const safe = guardCell(v);
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
