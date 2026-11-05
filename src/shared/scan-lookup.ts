/** The one key for a typed member, card or ticket number: NFKC, trim, upper-case, no space, `-`, `.` or `/`. */
export function normalizeLookup(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s\-./]/g, '');
}
