import { z } from 'zod';

export const CONNECTION_TABS = [
  'health',
  'mapping',
  'config',
  'settings',
  'webhook',
  'file',
] as const;

export const connectionDetailSearchSchema = z.object({
  tab: z.enum(CONNECTION_TABS).optional().catch(undefined),
});
export type ConnectionDetailSearch = z.infer<typeof connectionDetailSearchSchema>;
