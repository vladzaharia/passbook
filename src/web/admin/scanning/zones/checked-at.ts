import type { ScanZone } from '@/shared/contracts/scan-access.ts';

/** "Checked at Lobby, Lab": the sessions that check the zones, each once, in name order. */
export function checkedAtNames(zones: readonly Pick<ScanZone, 'checkedAt'>[]): string[] {
  const names = new Set(zones.flatMap((z) => z.checkedAt.map((s) => s.name)));
  return [...names].sort((a, b) => a.localeCompare(b));
}

export const checkedAtLine = (names: readonly string[]): string =>
  names.length > 0 ? `Checked at ${names.join(', ')}` : 'Not checked anywhere';
