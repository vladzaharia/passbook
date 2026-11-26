import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { ToolApi } from './api.ts';

/**
 * `GET /workbench/summary` (design §1.6, §3.6, S5): the nav's attention, counted after this
 * person's seen marks. A field the server leaves out reads as nothing to show, never an error.
 */
export const SUMMARY_PATH = '/api/v1/workbench/summary';
export const SUMMARY_POLL_MS = 30_000;

const count = z.number().int().nonnegative().catch(0);
export const SummarySchema = z.object({
  quickstart: z.object({ done: z.number(), total: z.number() }).nullable().catch(null),
  errors: count,
  failedDeliveries: count,
  listening: z.boolean().catch(false),
  inboxNew: count,
  keysExpiring: count,
});
export type WbSummary = z.infer<typeof SummarySchema>;

/** The areas whose counts clear when seen; their marks ride as `since[area]`. */
export const SEEN_AREAS = ['logs', 'events', 'inbox'] as const;
export type SeenArea = (typeof SEEN_AREAS)[number];

export function useWorkbenchSummary(api: ToolApi | null, since: Partial<Record<SeenArea, number>>) {
  const query: Record<string, number | undefined> = {};
  for (const area of SEEN_AREAS) query[`since[${area}]`] = since[area];
  return useQuery({
    queryKey: ['workbench', 'summary', api?.orgId, since] as const,
    queryFn: ({ signal }) => (api as ToolApi).get(SUMMARY_PATH, SummarySchema, { query, signal }),
    enabled: api !== null,
    // Every 30 s while the tab is visible (react-query pauses the interval when hidden).
    refetchInterval: SUMMARY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}
