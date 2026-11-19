import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';

const conflict = (message: string, code: string) => new ConflictError(message, code);

export type Prerequisite = 'check' | 'round_trip' | 'source' | 'verified';

/** An enable (or a source) that lacks something the caller can supply; `missing` names each. */
export const prerequisite = (missing: Prerequisite[]) =>
  new AppError('WALLET_ENROLMENT_PREREQUISITE', 409, 'Finish the missing steps first.', {
    issues: missing.map((path) => ({ path, message: 'missing' })),
  });

/**
 * Maps a refusal of a credential or enrolment batch to its stable 409. The 0112 triggers are the rule; the
 * services check first for a clearer path, and this is what a race or a hand-built call meets. Anything else
 * is returned as is, to be rethrown.
 */
export function mapWalletWriteError(error: unknown): unknown {
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
  if (/held by the platform/.test(text))
    return conflict('The platform holds this enrolment.', 'WALLET_ENROLMENT_HELD');
  if (/credential is in use|enrolment is in use|identity change needs retired/.test(text))
    return conflict('Retire the provider instances first.', 'WALLET_CREDENTIAL_IN_USE');
  if (
    /needs a fresh credential check|needs a Test round trip|needs a verified source|needs an active source/.test(
      text,
    )
  )
    return prerequisite([]);
  if (/belongs to the platform|identity_hash/.test(text))
    return conflict('That provider identity is already in use.', 'WALLET_IDENTITY_TAKEN');
  if (/must keep the credential identity|identity is immutable|card map is append-only/.test(text))
    return conflict('The provider identity cannot change.', 'WALLET_IDENTITY_IMMUTABLE');
  if (
    /needs the next revision|invalid wallet (credential|enrolment)|needs its event|source is unavailable|available credential|needs an active org|revoke needs it off|switch turns it off|identity follows its source|needs an enrolment without a legacy envelope/.test(
      text,
    ) ||
    classifyD1Error(error) !== null
  )
    return conflict('The wallet account changed. Reload and retry.', 'WALLET_ACCOUNT_CONFLICT');
  return error;
}
