import type { z } from 'zod';
import type { passDetailSearchSchema } from '../search.ts';

export type PassDetailSearch = z.infer<typeof passDetailSearchSchema>;
export type PassDetailTab = NonNullable<PassDetailSearch['tab']>;
