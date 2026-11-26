// Since 0226 only an enrolment that is On issues. The old configure route's envelope issued with no enrolment, and
// many tests still issue through one; they turn it On here. Production never reaches this state (an enable needs
// a source, a fresh check and, in Live, a Test round trip), so the enable rules are lifted for the one update.
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { configureWalletProviderAccount, revokeWalletProviderAccount } from './account-service.ts';

const ENABLE_RULES = [
  'wallet_enrolments_step',
  'wallet_enrolments_enable_source',
  'wallet_enrolments_enable_check',
  'wallet_enrolments_enable_round_trip',
];

/** Turns a legacy envelope account On, as if enabled; a no-op when it already is. */
export async function legacyOn(db: D1Database, accountId: string | null): Promise<void> {
  if (!accountId) throw new Error('No legacy account to turn on.');
  const set = async () => {
    await run(
      db,
      'UPDATE wallet_provider_accounts SET enabled_at = 1 WHERE id = ? AND enabled_at IS NULL',
      [accountId],
    );
  };
  await ENABLE_RULES.reduceRight<() => Promise<void>>(
    (next, name) => () => withoutTrigger(db, name, next),
    set,
  )();
}

/** `configureWalletProviderAccount`, then the account On: a legacy account that issues, as before 0226. */
export async function configureOn(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: Parameters<typeof configureWalletProviderAccount>[2],
): ReturnType<typeof configureWalletProviderAccount> {
  const ready = await configureWalletProviderAccount(ctx, auth, input);
  await legacyOn(ctx.env.DB, ready.accountId);
  return ready;
}

/** Back Off, as a legacy account always is in production; its revoke needs that (0112 transition rule). */
export async function legacyOff(db: D1Database, accountId: string): Promise<void> {
  await withoutTrigger(db, 'wallet_enrolments_step', async () => {
    await run(db, 'UPDATE wallet_provider_accounts SET enabled_at = NULL WHERE id = ?', [
      accountId,
    ]);
  });
}

/** `revokeWalletProviderAccount` of an account `configureOn` turned On: Off first, then the revoke. */
export async function revokeOff(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: Parameters<typeof revokeWalletProviderAccount>[2],
): ReturnType<typeof revokeWalletProviderAccount> {
  const row = await first<{ id: string }>(
    ctx.env.DB,
    'SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = ?',
    [input.orgId, input.mode, input.provider],
  );
  if (row) await legacyOff(ctx.env.DB, row.id);
  return revokeWalletProviderAccount(ctx, auth, input);
}
