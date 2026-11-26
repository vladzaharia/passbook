import { z } from 'zod';

/** `?mode=wallets&wallet=samsung`: the Wallets tab, focused on one wallet (import and release link here). */
export const designSearchSchema = z.object({
  mode: z.enum(['wallets']).optional().catch(undefined),
  wallet: z.enum(['google', 'samsung']).optional().catch(undefined),
});
export type DesignSearch = z.infer<typeof designSearchSchema>;
