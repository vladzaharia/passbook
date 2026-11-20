import type { z } from 'zod';
import type { ApiKeyListQuerySchema } from '../../../shared/contracts/index.ts';
import { apiKeyPrefixOf } from '../../platform/api-key-token.ts';
import { effectiveScopes, rolesCapableOf } from '../../platform/api-scopes.ts';
import type { ApiKeyAuth, ApiKeyStore } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { ipAllowed } from '../../platform/ip-allow.ts';
import { enforceApiKeyRate, rememberApiTier } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { seesAccountEmails } from '../passes/account-email.ts';
import { type ApiKeyAuthority, authorityOrgId } from './access.ts';
import * as repo from './repo.ts';
import { invalid } from './service-create.ts';
import { type ApiKeyDto, parseRoles, parseScopes, type Resources, toDto } from './service-dto.ts';

export { createApiKey } from './service-create.ts';
export type { ApiKeyDto } from './service-dto.ts';

const TOUCH_EVERY_MS = 5 * 60 * 1000;

/** The key behind a bearer: its settings and use, never the secret or its hash. */
export async function describeOwnKey(ctx: ServiceContext, auth: ApiKeyAuth) {
  const row = await repo.getKey(ctx.env.DB, auth.keyId, auth.orgId);
  if (!row) return null;
  const { id, orgId, name, prefix, scopes, mode, createdAt, lastUsedAt, expiresAt } = toDto(row);
  const { kind, roles, retireAt } = toDto(row);
  return {
    id,
    orgId,
    name,
    prefix,
    scopes,
    mode,
    createdAt,
    lastUsedAt,
    expiresAt,
    kind,
    roles,
    retireAt,
  };
}

/** One page, plus how many revoked keys the same org filter holds. */
export async function listApiKeys(
  ctx: ServiceContext,
  query: z.infer<typeof ApiKeyListQuerySchema>,
  authority: ApiKeyAuthority,
): Promise<{ items: ApiKeyDto[]; nextCursor: string | null; revokedCount: number }> {
  const orgId = authorityOrgId(authority);
  // A member without `integrations:read` (authorized as `org:read`) sees only their own personal keys.
  const mine =
    authority.kind === 'session' && authority.capability === 'org:read'
      ? authority.membershipId
      : undefined;
  const [rows, revokedCount] = await Promise.all([
    repo.listKeys(
      ctx.env.DB,
      { ...query, orgId, limit: query.limit + 1, mine },
      seesAccountEmails(authority),
    ),
    repo.countRevoked(ctx.env.DB, orgId, mine),
  ]);
  const page = rows.slice(0, query.limit);
  const resources = await repo.keyResources(
    ctx.env.DB,
    page.filter((row) => row.restricted === 1).map((row) => row.id),
  );
  const of = (id: string): Resources => ({
    templateIds: resources
      .filter((r) => r.key_id === id && r.kind === 'template')
      .map((r) => r.value),
    passStyles: resources
      .filter((r) => r.key_id === id && r.kind === 'pass_style')
      .map((r) => r.value) as Resources['passStyles'],
  });
  return {
    items: page.map((row) => toDto(row, of(row.id))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    revokedCount,
  };
}

/** Whether `id` is a personal key of the member behind `authority`. */
export async function isOwnPersonalKey(
  ctx: ServiceContext,
  id: string,
  orgId: string | null,
  authority: ApiKeyAuthority,
): Promise<boolean> {
  if (authority.kind !== 'session') return false;
  const key = await repo.getKey(ctx.env.DB, id, orgId);
  return key?.kind === 'personal' && key.membership_id === authority.membershipId;
}

/** Idempotent: revoking a revoked key succeeds. */
export async function revokeApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
): Promise<void> {
  const key = await repo.getKey(ctx.env.DB, id, authorityOrgId(authority));
  if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  await repo.revokeKey(ctx, id, authority, {
    orgId: key.org_id,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.revoke',
    targetType: 'api_key',
    targetId: id,
  });
}

/** Ends a key at an instant before it would otherwise end. Once only: a second call is a conflict. */
export async function retireApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  retireAt: number,
): Promise<void> {
  const key = await repo.getKey(ctx.env.DB, id, authorityOrgId(authority));
  if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  if (retireAt <= ctx.clock.now())
    throw invalid('Retirement must be in the future.', 'RETIRE_PAST', 'retireAt');
  if (key.expires_at !== null && retireAt > key.expires_at)
    throw invalid('Retirement cannot be after expiry.', 'RETIRE_AFTER_EXPIRY', 'retireAt');
  if (key.revoked_at !== null || key.retire_at !== null)
    throw new ConflictError('The key is already revoked or retiring.', 'API_KEY_RETIRE_SET');
  await repo.retireKey(ctx, id, retireAt, authority, {
    orgId: key.org_id,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.retire',
    targetType: 'api_key',
    targetId: id,
    detail: { retireAt },
  });
}

/** Resolves a presented key. Null for anything invalid; throws 429 when the key is over its limit. */
export function createApiKeyStore(env: AppEnv, clock: Clock = systemClock): ApiKeyStore {
  return {
    async resolve(rawKey, caller, options): Promise<ApiKeyAuth | null> {
      const prefix = apiKeyPrefixOf(rawKey);
      if (!prefix) return null;
      const row = await repo.findByPrefix(env.DB, prefix);
      if (!row || !(await safeEqual(await sha256Hex(rawKey), row.key_hash))) return null;
      const now = clock.now();
      if (
        row.revoked_at !== null ||
        (row.expires_at !== null && row.expires_at <= now) ||
        (row.retire_at !== null && row.retire_at <= now)
      )
        return null;
      if (row.org_id !== null && row.org_status !== 'active') return null;
      // A personal key dies with its membership or user; its reach is capped by the member's roles now.
      if (row.kind === 'personal' && row.member_roles === null) return null;
      // The caller's address is not an oracle: a wrong address looks like a wrong key. No address means no match.
      const allow = row.ip_allow ? (JSON.parse(row.ip_allow) as string[]) : [];
      if (allow.length > 0 && !ipAllowed(caller?.ip, allow)) return null;
      // A key limited to templates or styles is for routes that enforce the limit (`templateScoped`); anywhere else
      // it is refused, so a route that reads or writes outside the grant builder never sees another template's data.
      if (row.restricted === 1 && options?.limited !== 'ok')
        throw new ForbiddenError(
          'This key is limited to templates and cannot call this route.',
          'API_KEY_RESTRICTED_ROUTE',
        );
      const tier = await enforceApiKeyRate(
        env,
        { keyId: row.id, orgId: row.org_id },
        row.rate_tier,
      );
      await repo.touchKey(env.DB, row.id, now, TOUCH_EVERY_MS, ipPrefix(caller?.ip));
      const held = effectiveScopes(parseScopes(row.scopes), parseRoles(row.roles));
      const memberRoles = row.member_roles ? parseRoles(row.member_roles) : null;
      const auth: ApiKeyAuth = {
        kind: 'api_key',
        keyId: row.id,
        orgId: row.org_id,
        scopes: memberRoles
          ? held.filter((s) => rolesCapableOf(s).some((role) => memberRoles.includes(role)))
          : held,
        mode: row.mode,
        ...(row.restricted === 1 ? { limited: true as const } : {}),
      };
      rememberApiTier(auth, tier);
      return auth;
    },
  };
}
