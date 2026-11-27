import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from './common.ts';
import { WalletProviderSchema } from './wallet-providers.ts';

/** One wallet's health for an organization in one mode. Counts cover the provider API, not device installs. */
export const WalletHealthSchema = z.strictObject({
  provider: WalletProviderSchema,
  mode: ModeSchema,
  /** `failing`: the credentials were refused twice in a row. `attention`: failed or uncertain updates. */
  tone: z.enum(['ok', 'attention', 'failing', 'idle']),
  /** The last update the provider accepted. */
  lastSuccessAt: TimestampSchema.nullable(),
  /** Updates waiting to go out, in progress or scheduled to retry. */
  queued: z.number().int().nonnegative(),
  /** Updates that gave up in the last 24 hours. */
  failed24h: z.number().int().nonnegative(),
  /** Updates whose outcome is unknown. */
  uncertain: z.number().int().nonnegative(),
  /** Uncertain updates still inside the grace window: they settle by themselves. */
  uncertainWaiting: z.number().int().nonnegative(),
  /** The provider's last save or removal report. */
  callbackAt: TimestampSchema.nullable(),
});
export type WalletHealth = z.infer<typeof WalletHealthSchema>;

/** Only wallets open to the organization are listed. */
export const WalletHealthListSchema = z.strictObject({ items: z.array(WalletHealthSchema) });
export type WalletHealthList = z.infer<typeof WalletHealthListSchema>;

export const WalletHealthParamsSchema = z.strictObject({
  orgId: IdSchema,
  provider: WalletProviderSchema,
});

/** What a recheck started: `queued` updates go back to the queue, `waiting` are still inside the grace window. */
export const WalletRecheckResultSchema = z.strictObject({
  queued: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
});
export type WalletRecheckResult = z.infer<typeof WalletRecheckResultSchema>;
