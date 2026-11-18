/** Money is counted in integer minor units (cents); a stored amount stays a plain number of major units. */

/** Minor digits of a currency (USD 2, JPY 0, BHD 3). No or unknown currency: 2. */
export function minorDigits(currency?: string | null): number {
  if (!currency) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    return 2;
  }
}

/** The amount in minor units, or null when it has more digits than the currency allows. */
export function toMinor(amount: number, digits: number): number | null {
  const scale = 10 ** digits;
  const minor = Math.round(amount * scale);
  return Number.isFinite(minor) && Math.abs(minor / scale - amount) < 1e-9 ? minor : null;
}

export const fromMinor = (minor: number, digits: number): number => minor / 10 ** digits;

export type MoneyText = { minor: number } | { error: 'format' | 'digits' };

/** What staff typed ("4.5", "4,50"). `digits` is the currency's; more decimals than that are refused. */
export function parseMoney(text: string, digits: number): MoneyText {
  const t = text.trim();
  if (!/^\d*(?:[.,]\d*)?$/.test(t) || !/\d/.test(t)) return { error: 'format' };
  const [whole = '', frac = ''] = t.split(/[.,]/);
  if (frac.length > digits) return { error: 'digits' };
  return { minor: Number(`${whole || '0'}${frac.padEnd(digits, '0')}`) };
}

/** "Use at most 2 decimals." / "Use a whole amount." */
export const digitsMessage = (digits: number): string =>
  digits === 0 ? 'Use a whole amount.' : `Use at most ${digits} decimals.`;
