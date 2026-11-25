import { z } from 'zod';

/** Hours the replaced signing secret keeps signing: 0 drops it at once. */
export const RotateWebhookSecretSchema = z.object({
  overlapHours: z
    .union([z.literal(0), z.literal(1), z.literal(24), z.literal(72), z.literal(168)])
    .default(24),
});
export type OverlapHours = z.infer<typeof RotateWebhookSecretSchema>['overlapHours'];
