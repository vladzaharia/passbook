import type { SyncSnapshot } from './repo-pass-snapshot.ts';

/** Distinguish demonstrable counter drift from malformed or pending authority. */
export function validEpochNumbers(
  value: Pick<SyncSnapshot, 'credentialGeneration' | 'lifecycleGeneration'>,
): boolean {
  return (
    Number.isSafeInteger(value.credentialGeneration) &&
    value.credentialGeneration > 0 &&
    Number.isSafeInteger(value.lifecycleGeneration) &&
    value.lifecycleGeneration >= 0
  );
}
