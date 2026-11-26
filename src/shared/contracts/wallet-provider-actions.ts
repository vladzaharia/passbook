import { z } from 'zod';
import { IdSchema } from './common.ts';
import { SAMSUNG_CARD_TYPES, WalletProviderSchema } from './wallet-providers.ts';

/** Platform admin: name the Samsung card for one more type, without sending the partner's secrets again. */
export const SetSamsungCardSchema = z.strictObject({
  type: z.enum(SAMSUNG_CARD_TYPES),
  cardId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  expectedRevision: z.number().int().nonnegative(),
});
export type SetSamsungCard = z.infer<typeof SetSamsungCardSchema>;

/** Send every active Google or Samsung copy of the org's passes again (the twin of the Apple bulk reissue). */
export const WalletReissueSchema = z.strictObject({
  orgId: IdSchema.optional(),
  provider: WalletProviderSchema,
  templateId: IdSchema.optional(),
});
export type WalletReissue = z.infer<typeof WalletReissueSchema>;
export const WalletReissueResponseSchema = z.object({
  reissueId: z.string(),
  /** Copies the run reaches; passes nobody has added to a wallet have none yet. */
  instances: z.number().int().nonnegative(),
  /** The operation that shows the run; null when there was nothing to update. */
  operationId: z.string().nullable(),
});
export type WalletReissueResponse = z.infer<typeof WalletReissueResponseSchema>;

export const WalletCredentialListQuerySchema = z.strictObject({
  provider: WalletProviderSchema.optional(),
});
