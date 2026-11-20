/** Small build-time text helpers. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-18` as `Nov 18`. Build-time and fixed to UTC dates, so it needs no locale. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${Number(d)}`;
}

/** `1 operation`, `2 operations`. */
export const operations = (n: number) => `${n} ${n === 1 ? 'operation' : 'operations'}`;
