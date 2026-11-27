import type { z } from 'zod';
import type { EventDeliverySchema } from '@/shared/contracts/workbench-read.ts';

export type EventDelivery = z.infer<typeof EventDeliverySchema>;
