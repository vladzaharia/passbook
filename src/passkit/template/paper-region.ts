import type { PaperDesign } from './paper.ts';

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

/** The organization's time zone is in the US or Canada. */
export function usesLetter(timeZone: string | undefined): boolean {
  if (!timeZone) return false;
  return LETTER_ZONES.has(timeZone) || LETTER_PREFIXES.some((p) => timeZone.startsWith(p));
}

/** A design with no `paper` block prints on Letter for a US or Canadian org, A4 elsewhere. A block's size stands. */
export function withRegionSize(design: PaperDesign, timeZone: string | undefined): PaperDesign {
  return design.derived && usesLetter(timeZone) ? { ...design, size: 'letter' } : design;
}
