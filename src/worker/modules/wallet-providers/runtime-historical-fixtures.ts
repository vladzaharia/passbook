import { getWalletOperation } from './instance.ts';
import {
  type HistoricalProviderInstance,
  type HistoricalSamsungRef,
  insertHistoricalProviderInstance,
  insertHistoricalSamsungRef,
} from './repo-runtime-historical-test-fixtures.ts';

export type { HistoricalProviderInstance } from './repo-runtime-historical-test-fixtures.ts';
export { seedHistoricalOfferRef } from './repo-runtime-historical-test-fixtures.ts';

/**
 * Seed a reviewed historical instance, not a presently issuable provider credential.
 * Eligible synthetic setups must capture the commitment with ensureCredentialRefKeyset,
 * or requireCredentialRefKeyset if already established, and pass it explicitly.
 */
export async function seedHistoricalProviderInstance(
  db: D1Database,
  input: HistoricalProviderInstance,
) {
  if (
    typeof input.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.credentialKeysetCommitment)
  )
    throw new Error('Missing or invalid historical credential keyset commitment');
  await insertHistoricalProviderInstance(db, input);
  return input.upsert
    ? getWalletOperation(db, {
        instanceId: input.id,
        orgId: input.orgId,
        mode: input.mode,
        provider: input.provider,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
        version: 1,
      })
    : null;
}

/** Restore a pre-existing encrypted reference without authorizing new Samsung references. */
export async function seedHistoricalSamsungRef(db: D1Database, input: HistoricalSamsungRef) {
  if (
    typeof input.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.credentialKeysetCommitment)
  )
    throw new Error('Missing or invalid historical credential keyset commitment');
  await insertHistoricalSamsungRef(db, input);
}
