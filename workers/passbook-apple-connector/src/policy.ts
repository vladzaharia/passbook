import { AscError } from './types.ts';

export const MANAGED_PREFIX = 'pass.mobile.passbook.';
/** Their certificates back every installed platform pass; the owner revokes them by hand. */
export const PLATFORM_IDENTIFIERS = new Set(['pass.im.plrs.wallet', `${MANAGED_PREFIX}wallet`]);
const HANDLE = /^[a-z][a-z0-9]{1,29}$/;
const RESERVED = new Set([
  'wallet',
  'test',
  'demo',
  'platform',
  'passbook',
  'apple',
  'google',
  'samsung',
  'admin',
  'api',
]);

export function refuse(message: string): never {
  throw new AscError('ASC_REFUSED', message);
}

/** Managed identifier for a handle (design 2.3). */
export function managedIdentifier(handle: string): string {
  if (!HANDLE.test(handle)) refuse('Invalid handle.');
  if (RESERVED.has(handle)) refuse('Reserved handle.');
  return `${MANAGED_PREFIX}${handle}`;
}

export function assertManagedIdentifier(identifier: string): void {
  if (
    !identifier.startsWith(MANAGED_PREFIX) ||
    !HANDLE.test(identifier.slice(MANAGED_PREFIX.length))
  )
    refuse('Identifier is outside the managed prefix.');
}

export function assertPassTypeName(name: string): void {
  if (name.length < 1 || name.length > 100 || [...name].some((c) => c.charCodeAt(0) < 32))
    refuse('Invalid name.');
}

/** The only reason the provisioner revokes for. */
export function assertRevokeReason(reason: string): void {
  if (reason !== 'compromised') refuse('Revoke only for reason compromised.');
}

/** Platform certificate work is owner-run (docs/operations.md), never an RPC: the provisioner does not trust the main Worker's limits. */
export function assertOrderable(identifier: string): void {
  assertManagedIdentifier(identifier);
  if (PLATFORM_IDENTIFIERS.has(identifier))
    refuse('Platform pass type certificates are ordered by the owner only.');
}
