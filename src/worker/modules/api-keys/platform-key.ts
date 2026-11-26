import type { ApiKeyKind } from '../../platform/api-key-token.ts';
import { IdpSignInRequiredError, ValidationError } from '../../platform/errors.ts';
import type { ApiKeyAuthority } from './access.ts';

const DAY_MS = 86_400_000;
/** A Platform key with a write scope lives at most 30 days; a day of slack covers a client clock that runs ahead. */
export const MAX_PLATFORM_WRITE_LIFETIME_MS = 31 * DAY_MS;

/** The one issue a platform-key refusal carries. The code stays a literal at each `new ValidationError`, where the error catalog reads it. */
const issue = (message: string, path = 'scopes') => [{ path, message }];

/**
 * Only a person in a Polaris ID session makes or rotates a Platform key: a break-glass session is an incident tool
 * and must not leave a control-plane credential behind. The step-up is the route's (a key never steps up: this mint was it).
 */
export function assertPlatformMintSession(authority: ApiKeyAuthority): void {
  if (authority.kind === 'platform' && authority.amr !== 'oidc')
    throw new IdpSignInRequiredError('/auth/oidc/start?next=/admin');
}

/**
 * The rules for a key that holds a `platform:*` scope (all 422 unless noted): only the platform kind holds one; it
 * holds platform scopes alone (two keys, not one that does both); Live only; a Polaris ID session mints it (403);
 * at most 30 days when any scope is not `platform:read` (a read-only key keeps the 90 days of every platform key).
 * The IP allowlist and the expiry's presence are `checkKindRules`'s.
 */
export function assertPlatformKey(
  authority: ApiKeyAuthority,
  kind: ApiKeyKind,
  mode: 'live' | 'test',
  held: readonly string[],
  expiresAt: number | null | undefined,
  now: number,
): void {
  const platform = held.filter((s) => s.startsWith('platform:'));
  if (platform.length === 0) return;
  if (kind !== 'platform')
    throw new ValidationError(
      'Platform scopes are for platform keys.',
      issue('Platform scopes are for platform keys.'),
      'API_KEY_PLATFORM_SCOPE_KIND',
    );
  if (platform.length !== held.length)
    throw new ValidationError(
      'A key holds platform scopes or organization scopes, not both. Make two keys.',
      issue('A key holds platform scopes or organization scopes, not both. Make two keys.'),
      'API_KEY_PLATFORM_SCOPES_ALONE',
    );
  if (mode !== 'live')
    throw new ValidationError(
      'A platform key is Live only.',
      issue('A platform key is Live only.', 'mode'),
      'API_KEY_PLATFORM_LIVE',
    );
  assertPlatformMintSession(authority);
  if (
    platform.some((s) => s !== 'platform:read') &&
    expiresAt != null &&
    expiresAt > now + MAX_PLATFORM_WRITE_LIFETIME_MS
  )
    throw new ValidationError(
      'A platform key lives at most 30 days.',
      issue('A platform key lives at most 30 days.', 'expiresAt'),
      'API_KEY_EXPIRY_TOO_LONG',
    );
}
