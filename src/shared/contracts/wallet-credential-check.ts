import { z } from 'zod';
import { TimestampSchema } from './common.ts';

/** The newest check of a credential's current version: a pass has no code, a failure has one. */
export const WalletCredentialLastCheckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), code: z.null(), at: TimestampSchema }),
  z.strictObject({ ok: z.literal(false), code: z.string(), at: TimestampSchema }),
]);
