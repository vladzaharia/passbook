import type { GoogleWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialIdentityHash } from './account-credential-source.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import {
  type ClaimRow,
  getClaim,
  insertClaim,
  moveClaim,
  orgHoldsIssuer,
  platformHoldsIssuer,
} from './repo-google-managed.ts';

export const issuerHash = (issuerId: string) =>
  credentialIdentityHash({
    provider: 'google',
    credentials: {
      issuerId,
      serviceAccountEmail: '',
      privateKeyPem: '',
      scopes: [GOOGLE_WALLET_SCOPE],
    } satisfies GoogleWalletCredentials,
  });

const taken = () =>
  new ConflictError('Another organization uses this issuer.', 'WALLET_ISSUER_CLAIMED');

/**
 * One org per issuer, across modes and for good. A claim by another org holds while that org still has
 * the issuer; once it let go, only an issuer the org owned itself (`shared`, `manual`) can move, and only
 * with proof of ownership (`owned`). An issuer PassBook created never moves. PassBook's own issuers are nobody's.
 */
export async function claimIssuer(
  ctx: ServiceContext,
  input: { issuerId: string; orgId: string; origin: ClaimRow['origin']; owned: boolean },
): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const hash = await issuerHash(input.issuerId);
  if (await platformHoldsIssuer(db, hash)) throw taken();
  const row = { issuer_id: input.issuerId, org_id: input.orgId, origin: input.origin };
  if (await insertClaim(db, { ...row, now })) return;
  const held = await getClaim(db, input.issuerId);
  if (!held) return claimIssuer(ctx, input);
  if (held.org_id === input.orgId) return;
  if (held.origin === 'created' || !input.owned || (await orgHoldsIssuer(db, held.org_id, hash)))
    throw taken();
  if (!(await moveClaim(db, { ...row, from: held.org_id, now }))) throw taken();
}
