import { z } from 'zod';

export const ENDPOINT_TABS = ['overview', 'deliveries', 'signing'] as const;

export const endpointDetailSearchSchema = z.object({
  tab: z.enum(ENDPOINT_TABS).optional().catch(undefined),
});
export type EndpointTab = (typeof ENDPOINT_TABS)[number];
