import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { accountHmacKind } from '../keys/rewrap-tables.ts';

/**
 * The enrolment's own HMAC key as the account columns of its first source step: 32 fresh random bytes
 * (base64url), enveloped for this account, org, mode and provider alone. Never derived from, or copied
 * out of, another row.
 */
export async function newEnrolmentKeyColumns(
  ctx: ServiceContext,
  account: { id: string; orgId: string; mode: string; provider: string },
): Promise<Record<string, SqlValue>> {
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    ctx.ids.token(32),
    credentialAad(
      account.id,
      account.orgId,
      accountHmacKind(account.id, account.mode, account.provider),
    ),
  );
  return {
    hmac_kek_version: envelope.kekVersion,
    hmac_iv: envelope.iv,
    hmac_wrapped_dek: envelope.wrappedDek,
    hmac_ciphertext: envelope.ciphertext,
  };
}
