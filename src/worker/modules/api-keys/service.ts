import type { z } from 'zod';
import type { ApiKeyListQuerySchema } from '../../../shared/contracts/index.ts';
import { apiKeyPrefixOf } from '../../platform/api-key-token.ts';
import { CREDENTIAL_SCOPES, rolesCapableOf } from '../../platform/api-scopes.ts';
import type { ApiKeyAuth, ApiKeyStore, KeyCaller } from '../../platform/auth.ts';
import {
  keyInBrowserMode,
  keyInBrowserRefusal,
  reportKeyInBrowser,
} from '../../platform/browser-signals.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { ipAllowed } from '../../platform/ip-allow.ts';
import { createLogger } from '../../platform/log.ts';
import { enforceApiKeyRate, rememberApiTier } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { seesAccountEmails } from '../passes/account-email.ts';
import { type ApiKeyAuthority, actorOf, authorityOrgId } from './access.ts';
import * as repo from './repo.ts';
import { selfSuccessors } from './repo-family.ts';
import { invalid, MAX_LIFETIME_MS } from './service-create.ts';
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
  // A key lists its own children, whatever else it asks for.
  const parent = authority.kind === 'api_key' ? authority.keyId : query.parentKeyId;
  const [rows, revokedCount] = await Promise.all([
    repo.listKeys(
      ctx.env.DB,
      { ...query, orgId, limit: query.limit + 1, mine, parent },
      seesAccountEmails(authority),
    ),
    repo.countRevoked(ctx.env.DB, orgId, mine, parent),
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
    items: page.map((row) => toDto(row, of(row.id), authority.kind !== 'api_key')),
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

/** The key `id` of the caller's org, or 404: a key sees only its own children, whatever other keys exist. */
export async function reachable(ctx: ServiceContext, authority: ApiKeyAuthority, id: string) {
  const key = await repo.getKey(ctx.env.DB, id, authorityOrgId(authority));
  if (!key || (authority.kind === 'api_key' && key.parent_key_id !== authority.keyId))
    throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  return key;
}

/** Idempotent: revoking a revoked key succeeds. */
export async function revokeApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
): Promise<void> {
  const key = await reachable(ctx, authority, id);
  const children = await repo.countOpenChildren(ctx.env.DB, id);
  const successors = await selfSuccessors(ctx.env.DB, id);
  await repo.revokeKey(
    ctx,
    id,
    authority,
    {
      orgId: key.org_id,
      ...actorOf(authority),
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: id,
      ...(children + successors.length > 0
        ? {
            detail: {
              ...(children > 0 ? { children } : {}),
              ...(successors.length > 0 ? { successors: successors.length } : {}),
            },
          }
        : {}),
    },
    successors,
  );
}

/** Ends a key at an instant before it would otherwise end. Once only: a second call is a conflict. */
export async function retireApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  retireAt: number,
): Promise<void> {
  const key = await reachable(ctx, authority, id);
  if (retireAt <= ctx.clock.now())
    throw invalid('Retirement must be in the future.', 'RETIRE_PAST', 'retireAt');
  if (key.expires_at !== null && retireAt > key.expires_at)
    throw invalid('Retirement cannot be after expiry.', 'RETIRE_AFTER_EXPIRY', 'retireAt');
  if (key.revoked_at !== null || key.retire_at !== null)
    throw new ConflictError('The key is already revoked or retiring.', 'API_KEY_RETIRE_SET');
  await repo.retireKey(ctx, id, retireAt, authority, {
    orgId: key.org_id,
    ...actorOf(authority),
    action: 'api_key.retire',
    targetType: 'api_key',
    targetId: id,
    detail: { retireAt },
  });
}

/**
 * The principal of a found key row, or null when the key may not act now: revoked, expired, retired, its org or
 * member gone, or the caller outside its IP list. Throws 429 over the key's limit. Shared by the secret and the
 * developer try-token paths, so both apply the same rules.
 */
export async function keyAuthOf(
  env: AppEnv,
  clock: Clock,
  row: repo.ResolvedKeyRow,
  caller: KeyCaller | undefined,
  options: { limited?: 'ok' } | undefined,
): Promise<ApiKeyAuth | null> {
  const now = clock.now();
  if (
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= now) ||
    (row.retire_at !== null && row.retire_at <= now)
  )
    return null;
  if (row.org_id !== null && row.org_status !== 'active') return null;
  // A child ends with its parent: revoked, expired or retired, or gone.
  if (row.parent_key_id !== null) {
    const parent = row.parent
      ? (JSON.parse(row.parent) as Record<'revoked_at' | 'expires_at' | 'retire_at', number | null>)
      : null;
    const ends = parent ? [parent.expires_at, parent.retire_at].filter((t) => t !== null) : [];
    if (!parent || parent.revoked_at !== null || ends.some((t) => t <= now)) return null;
  }
  // A personal key dies with its membership or user; its reach is capped by the member's roles now.
  if (row.kind === 'personal' && row.member_roles === null) return null;
  // The caller's address is not an oracle: a wrong address looks like a wrong key. No address means no match.
  const allow = row.ip_allow ? (JSON.parse(row.ip_allow) as string[]) : [];
  if (allow.length > 0 && !ipAllowed(caller?.ip, allow)) return null;
  // After the address check, so a caller outside the list learns nothing about the owner.
  // A personal key acts for a person, so it needs the person's strong sign-in to exist: a Polaris ID identity,
  // or the console grace the member was given when this rule started.
  if (
    row.kind === 'personal' &&
    row.owner_idp !== 1 &&
    !(typeof row.owner_grace_until === 'number' && now < row.owner_grace_until)
  ) {
    createLogger().warn('api_key.owner_needs_idp', {
      code: 'KEY_OWNER_NEEDS_IDP',
      keyId: row.id,
      orgId: row.org_id,
    });
    throw new ForbiddenError(
      "This key's owner must sign in with Polaris ID once.",
      'KEY_OWNER_NEEDS_IDP',
    );
  }
  const tier = await enforceApiKeyRate(env, { keyId: row.id, orgId: row.org_id }, row.rate_tier);
  // A key limited to templates or styles is for routes that enforce the limit (`templateScoped`); anywhere else
  // it is refused, so a route that reads or writes outside the grant builder never sees another template's data.
  if (row.restricted === 1 && options?.limited !== 'ok')
    throw new ForbiddenError(
      'This key is limited to templates and cannot call this route.',
      'API_KEY_RESTRICTED_ROUTE',
    );
  await repo.touchKey(env.DB, row.id, now, TOUCH_EVERY_MS, ipPrefix(caller?.ip));
  // A platform key made before 0142 has no expiry or IP list: it keeps working, and every use is logged.
  if (row.kind === 'platform' && (row.expires_at === null || allow.length === 0))
    createLogger().warn('api_key.platform_unbounded', {
      code: 'API_KEY_PLATFORM_UNBOUNDED',
      keyId: row.id,
    });
  // A credential scope counts only on a key that satisfies the mint rule (no role, expiry within 91 days, no parent): a key made by an older version holds it in vain.
  const credentialOk =
    parseRoles(row.roles).length === 0 &&
    row.parent_key_id === null &&
    row.expires_at !== null &&
    row.expires_at <= row.created_at + MAX_LIFETIME_MS;
  const held = parseScopes(row.scopes).filter(
    (s) => credentialOk || !(CREDENTIAL_SCOPES as readonly string[]).includes(s),
  );
  const memberRoles = row.member_roles ? parseRoles(row.member_roles) : null;
  const auth: ApiKeyAuth = {
    kind: 'api_key',
    keyId: row.id,
    orgId: row.org_id,
    keyKind: row.kind,
    scopes: memberRoles
      ? held.filter((s) => rolesCapableOf(s).some((role) => memberRoles.includes(role)))
      : held,
    mode: row.mode,
    ...(row.restricted === 1 ? { limited: true as const } : {}),
    ...(row.org_kind === 'developer' ? { orgKind: 'developer' as const } : {}),
  };
  rememberApiTier(auth, tier);
  return auth;
}

/** Resolves a presented key. Null for anything invalid; throws 429 when the key is over its limit. */
export function createApiKeyStore(env: AppEnv, clock: Clock = systemClock): ApiKeyStore {
  return {
    async resolve(rawKey, caller, options): Promise<ApiKeyAuth | null> {
      const prefix = apiKeyPrefixOf(rawKey);
      if (!prefix) {
        if (caller?.browser) throw keyInBrowserRefusal(null);
        return null;
      }
      const row = await repo.findByPrefix(env.DB, prefix);
      // From a browser: refused before the secret is checked or the key touched, unless the key predates the rollout.
      const browser = caller?.browser
        ? keyInBrowserMode(row?.created_at ?? null, clock.now())
        : null;
      const seen = row ? { orgId: row.org_id, prefix: row.prefix } : null;
      if (browser === 'enforce') throw keyInBrowserRefusal(seen);
      if (!row || !(await safeEqual(await sha256Hex(rawKey), row.key_hash))) return null;
      const auth = await keyAuthOf(env, clock, row, caller, options);
      if (auth && browser === 'report' && seen) reportKeyInBrowser(caller, seen);
      return auth;
    },
  };
}
