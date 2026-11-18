import type { z } from 'zod';
import type { ScanInsideListSchema } from '@/shared/contracts/scan-occupancy.ts';

/** Who is inside a place, and counting someone out by hand. */
export interface InsideApi {
  list(place: string, cursor?: string): Promise<z.infer<typeof ScanInsideListSchema>>;
  markOut(passId: string, place: string): Promise<void>;
}

/**
 * The console has no inside-list or Mark as out route yet (server WP-E and WP-G): the scan routes
 * are device-only. Until one exists this is null and the zone menu hides both. Return the
 * implementation here when the route lands.
 */
export function useInsideApi(): InsideApi | null {
  return null;
}
