import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ApiKeyAuthority, actorOf, authorityOrgId } from './access.ts';
import { assertPlatformMintSession } from './platform-key.ts';
import { getKey, keyResources } from './repo.ts';
import { createKey } from './repo-create.ts';
import { terminalsOf } from './repo-family.ts';
import type { ApiKeyRow } from './repo-row.ts';
import { assertSandboxCeiling } from './sandbox-ceiling.ts';
import { reachable } from './service.ts';
import { assertCredentialKey, assertOrgBoundScopes, invalid } from './service-create.ts';
import type { ApiKeyDto } from './service-dto.ts';
import { parseScopes, type Resources, toDto } from './service-dto.ts';
import { newSecret } from './service-secret.ts';

const HOUR = 3_600_000;

/**
 * Replaces a key: the new secret works at once, and the old key retires `overlapHours` later (never after its own
 * expiry), in one batch. The new key has the old one's stored scopes, roles, mode, addresses, expiry, limits and
 * terminals, and the same parent; it is made under the caller's ceiling, so a member cannot rotate a key into a
 * secret they could not have minted. A child of the old key stops when the old key does: mint new children
 * from the new one.
 */
export async function rotateApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  overlapHours: number,
): Promise<{ key: ApiKeyDto & { secret: string }; previous: ApiKeyDto }> {
  const self = authority.kind === 'api_key' && id === authority.keyId;
  const old: ApiKeyRow | null = self
    ? await getKey(ctx.env.DB, id, authorityOrgId(authority))
    : await reachable(ctx, authority, id);
  if (!old) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  const now = ctx.clock.now();
  if (
    old.revoked_at !== null ||
    old.retire_at !== null ||
    (old.expires_at !== null && old.expires_at <= now)
  )
    throw new ConflictError('The key is revoked, retiring or expired.', 'API_KEY_NOT_ROTATABLE');
  if (old.origin === 'cli')
    throw new ConflictError(
      'A CLI sign-in is not rotated: run passbook login again.',
      'API_KEY_NOT_ROTATABLE',
    );
  // A personal key is its member's: no one else is handed its successor's secret.
  if (
    old.kind === 'personal' &&
    (authority.kind !== 'session' || old.membership_id !== authority.membershipId)
  )
    throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  if (authority.kind === 'session' && authority.mode !== old.mode)
    throw new ForbiddenError("Switch to the key's mode to rotate it.", 'API_KEY_MODE_MISMATCH');
  if (old.kind === 'platform' && (old.expires_at === null || old.ip_allow === null))
    throw invalid(
      'This key has no expiry or allowed addresses: make a new key.',
      'API_KEY_ROTATE_LEGACY',
      'id',
    );
  const retireAt = Math.min(now + overlapHours * HOUR, old.expires_at ?? Infinity);
  const [rows, terminalIds] = await Promise.all([
    keyResources(ctx.env.DB, [old.id]),
    terminalsOf(ctx.env.DB, old.id),
  ]);
  const resources: Resources = {
    templateIds: rows.filter((r) => r.kind === 'template').map((r) => r.value),
    passStyles: rows
      .filter((r) => r.kind === 'pass_style')
      .map((r) => r.value) as Resources['passStyles'],
  };
  // A key made before the ceiling held keeps no successor: make a new one.
  await assertSandboxCeiling(ctx.env.DB, old.org_id, parseScopes(old.scopes));
  // The successor keeps the old expiry: a credential key with none, or with more than 90 days left, is replaced, not rotated.
  assertCredentialKey(parseScopes(old.scopes), old.kind, old.mode, old.expires_at, now);
  assertOrgBoundScopes(parseScopes(old.scopes), old.kind);
  // A Platform key's successor is made in a Polaris ID session too (it keeps the old expiry, so the cap holds).
  if (parseScopes(old.scopes).some((s) => s.startsWith('platform:')))
    assertPlatformMintSession(authority);
  const { prefix, label, secret, hash } = await newSecret(ctx, old.kind, old.mode);
  const row: ApiKeyRow = {
    ...old,
    id: ctx.ids.id(),
    prefix,
    key_hash: hash,
    secret_label: label,
    // A key that rotates itself keeps its creator (a template scope acts as that member, rechecked live).
    created_by: authority.kind === 'api_key' ? old.created_by : authority.userId,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
    retire_at: null,
    // `rate_tier` stays: a tier a platform admin set follows the key.
    last_ip_prefix: null,
    rotated_from: old.id,
    created_by_key: authority.kind === 'api_key' ? authority.keyId : null,
    created_amr: authority.kind === 'api_key' ? null : authority.amr,
  };
  await createKey(
    ctx,
    row,
    authority,
    {
      orgId: row.org_id,
      ...actorOf(authority),
      action: 'api_key.rotate',
      targetType: 'api_key',
      targetId: row.id,
      detail: { from: old.id, overlapHours, retireAt, kind: row.kind, mode: row.mode },
    },
    {
      terminalIds,
      templateIds: resources.templateIds,
      passStyles: resources.passStyles,
      replaces: { id: old.id, retireAt, parent: old.parent_key_id, self },
    },
  );
  return {
    key: { ...toDto(row, resources), secret },
    previous: { ...toDto(old, resources), retireAt },
  };
}
