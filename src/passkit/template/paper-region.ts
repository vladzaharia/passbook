import type { PaperDesign } from './paper.ts';
import { type PaperSheet, sheetApplies } from './paper-sizes.ts';

/** IANA zones of the United States and Canada, where home printers hold Letter, not A4. */
const LETTER_ZONES = new Set([
  'Pacific/Honolulu',
  'America/Adak',
  'America/Anchorage',
  'America/Juneau',
  'America/Sitka',
  'America/Nome',
  'America/Yakutat',
  'America/Metlakatla',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Boise',
  'America/Denver',
  'America/Chicago',
  'America/Menominee',
  'America/Detroit',
  'America/New_York',
  'America/Vancouver',
  'America/Edmonton',
  'America/Calgary',
  'America/Regina',
  'America/Winnipeg',
  'America/Toronto',
  'America/Halifax',
  'America/Moncton',
  'America/Glace_Bay',
  'America/Goose_Bay',
  'America/St_Johns',
  'America/Whitehorse',
  'America/Dawson',
  'America/Iqaluit',
  'America/Yellowknife',
  'America/Inuvik',
  'America/Cambridge_Bay',
  'America/Rankin_Inlet',
  'America/Resolute',
  'America/Thunder_Bay',
  'America/Nipigon',
  'America/Rainy_River',
  'America/Fort_Nelson',
  'America/Creston',
  'America/Dawson_Creek',
  'America/Swift_Current',
  'America/Atikokan',
  'America/Blanc-Sablon',
  'America/Pangnirtung',
]);

const LETTER_PREFIXES = ['America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/'];

const LETTER_EXTRA = [
  'America/Puerto_Rico',
  'America/St_Thomas',
  'America/Virgin',
  'Pacific/Guam',
  'Pacific/Saipan',
  'Pacific/Pago_Pago',
  'Pacific/Samoa',
  // Links V8 keeps as their own names.
  'America/Indianapolis',
  'America/Fort_Wayne',
  'America/Knox_IN',
  'America/Louisville',
];
const LETTER_LOWER = new Set([...LETTER_ZONES, ...LETTER_EXTRA].map((z) => z.toLowerCase()));
const PREFIXES_LOWER = LETTER_PREFIXES.map((p) => p.toLowerCase());

/** The zone under its canonical name (US/Eastern is America/New_York); an unknown name stays as given. */
function canonical(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/** The organization's time zone is in the US, its territories or Canada. */
export function usesLetter(timeZone: string | undefined): boolean {
  if (!timeZone) return false;
  const names = new Set([timeZone.toLowerCase(), canonical(timeZone).toLowerCase()]);
  return [...names].some((n) => LETTER_LOWER.has(n) || PREFIXES_LOWER.some((p) => n.startsWith(p)));
}

/** The home sheet for an org's zone: Letter in the US and Canada, A4 elsewhere. */
export const regionSheet = (timeZone: string | undefined): PaperSheet =>
  usesLetter(timeZone) ? 'letter' : 'a4';

/** A design with no `paper` block prints on Letter for a US or Canadian org, A4 elsewhere. A block's size stands. */
export function withRegionSize(design: PaperDesign, timeZone: string | undefined): PaperDesign {
  return design.derived && usesLetter(timeZone) ? { ...design, size: 'letter' } : design;
}

/**
 * A holder prints at home: every card or strip size goes on the region's sheet (A4 or Letter) at true
 * size with cut marks; an explicit `paper.sheet` overrides the region. Staff print the exact page.
 */
export function forAudience(
  design: PaperDesign,
  audience: 'holder' | 'staff',
  timeZone: string | undefined,
): PaperDesign {
  const sized = withRegionSize(design, timeZone);
  if (audience === 'staff') {
    const { sheet: _sheet, ...exact } = sized;
    return exact;
  }
  return sheetApplies(sized.size)
    ? { ...sized, sheet: sized.sheet ?? regionSheet(timeZone) }
    : sized;
}
