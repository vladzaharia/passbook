/** RFC 4180 CSV: quotes fields with commas, quotes or line breaks; CRLF rows. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => {
    // A leading =, +, - or @ makes spreadsheets run the cell as a formula: prefix a quote.
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

const BOM = String.fromCharCode(0xfeff);

/** Saves text as a file through a temporary object URL. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  // A byte order mark so spreadsheet apps read the file as UTF-8.
  const url = URL.createObjectURL(new Blob([BOM + text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
