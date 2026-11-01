import { z } from 'zod';

export const templateDetailSearchSchema = z.object({
  tab: z.enum(['overview', 'versions', 'manifest', 'inputs']).optional().catch(undefined),
});
