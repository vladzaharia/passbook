import { z } from 'zod';

export const SCANNING_TABS = ['sessions', 'scanners', 'events', 'staff', 'scans'] as const;
export type ScanningTab = (typeof SCANNING_TABS)[number];
export const DEFAULT_TAB: ScanningTab = 'sessions';

const id = z.string().min(1).max(64).optional().catch(undefined);

/**
 * `/admin/scanning?tab=`. Everything but `tab` is a filter the Scans tab reads (and links from
 * dashboards and rows fill); filters ride along when the tab changes. `new=1` opens the shared
 * session form from either the Sessions or Devices tab.
 */
export const scanningSearchSchema = z.object({
  tab: z.enum(SCANNING_TABS).optional().catch(undefined),
  // A hand-typed ?new=1 parses as the number 1; the palette sends the string.
  new: z
    .preprocess((v) => (v === 1 || v === '1' ? '1' : undefined), z.literal('1').optional())
    .catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
  scannerId: id,
  staffId: id,
  eventId: id,
  outcome: z.enum(['ok', 'heads_up', 'refused', 'undone']).optional().catch(undefined),
  reason: z.string().min(1).max(40).optional().catch(undefined),
  range: z.enum(['today', '7d', '30d']).optional().catch(undefined),
});
export type ScanningSearch = z.infer<typeof scanningSearchSchema>;

/** Search for another tab: filters stay, the default tab and the create flag drop out. */
export function withTab(prev: ScanningSearch, tab: ScanningTab): ScanningSearch {
  const { new: _new, ...rest } = prev;
  return { ...rest, tab: tab === DEFAULT_TAB ? undefined : tab };
}
