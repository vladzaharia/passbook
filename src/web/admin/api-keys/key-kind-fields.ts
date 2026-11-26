import { MINTABLE_PLATFORM_SCOPES, PLATFORM_KEY_SCOPES } from '@/shared/contracts/api-keys.ts';

/** A personal or platform key lives at most 90 days. */
export const SHORT_EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
export const EXPIRY = [
  ...SHORT_EXPIRY,
  { value: '180', label: '6 months' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

/** A write scope on a Platform key caps it at 30 days; `platform:read` alone keeps 90. */
export const PLATFORM_WRITE_EXPIRY = SHORT_EXPIRY.filter((o) => o.value !== '90');

/** Platform scopes some route accepts by key; never one the server would refuse at mint. */
export const offeredPlatformScopes = (): readonly string[] =>
  PLATFORM_KEY_SCOPES.filter((s) => (MINTABLE_PLATFORM_SCOPES as readonly string[]).includes(s));

export const isPlatformScope = (s: string) => s.startsWith('platform:');

/** Which keys a platform-page key reaches: the control plane, or the organizations. */
export const keyReach = (k: { scopes: readonly string[] }) =>
  k.scopes.some(isPlatformScope) ? 'Platform' : 'All organizations';

/** What a Platform key never does, however it is scoped. */
export const PLATFORM_KEY_NEVER =
  'Freeze Polaris ID, clear the SCIM breaker, offboard, lift holds, apply a wallet release, change sign-in, revoke certificates';
