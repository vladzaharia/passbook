import { z } from 'zod';
import { TimestampSchema } from './common.ts';

/** The newest check of a credential's current version, passed or failed. */
export const WalletCredentialLastCheckSchema = z.strictObject({
  ok: z.boolean(),
  code: z.string().nullable(),
  at: TimestampSchema,
});
