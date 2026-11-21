import { z } from 'zod';

/** Its own file so the pass list's route search schema does not load the pass contracts. */
export const PassListStatusSchema = z.enum(['active', 'voided', 'removed']);
