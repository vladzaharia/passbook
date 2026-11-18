import { z } from 'zod';

export const importSearchSchema = z.object({ orgId: z.string().optional().catch(undefined) });
