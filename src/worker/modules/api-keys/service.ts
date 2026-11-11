import type { z } from 'zod';
import type {
  ApiKeyListQuerySchema,
  ApiKeySchema,
  CreateApiKeySchema,
} from '../../../shared/contracts/index.ts';
import type { ApiKeyStore } from '../../platform/auth.ts';
import { API_SCOPES, type ApiKeyAuth, type ApiScope } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { parseJsonArray } from '../../platform/json-column.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { type ApiKeyAuthority, authorityOrgId, delegableScopes } from './access.ts';
import * as repo from './repo.ts';

export type ApiKeyDto = z.infer<typeof ApiKeySchema>;
const KEY_SHAPE = /^wlt_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;
const parseScopes = (raw: string): ApiScope[] =>
  parseJsonArray(raw, 'scopes', (s): s is ApiScope => API_SCOPES.includes(s as ApiScope));
const TOUCH_EVERY_MS = 5 * 60 * 1000;

function toDto(row: repo.ApiKeyRow & { created_by_name?: string | null }): ApiKeyDto {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    mode: row.mode,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** One page, plus how many revoked keys the same org filter holds. */
export async function listApiKeys(
  ctx: ServiceContext,
  query: z.infer<typeof ApiKeyListQuerySchema>,
  authority: ApiKeyAuthority,
): Promise<{ items: ApiKeyDto[]; nextCursor: string | null; revokedCount: number }> {
  const orgId = authorityOrgId(authority);
  const [rows, revokedCount] = await Promise.all([
    repo.listKeys(ctx.env.DB, { ...query, orgId, limit: query.limit + 1 }),
    repo.countRevoked(ctx.env.DB, orgId),
  ]);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toDto),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    revokedCount,
  };
}

export async function createApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  input: z.infer<typeof CreateApiKeySchema>,
): Promise<ApiKeyDto & { secret: string }> {
  const now = ctx.clock.now();
  const orgId = input.orgId;
  if (
    orgId !== authorityOrgId(authority) ||
    (authority.kind === 'session' && authority.capability !== 'integrations:manage')
  ) {
    throw new ForbiddenError();
  }
  const delegable = delegableScopes(authority);
  if (input.scopes.some((scope) => !delegable.includes(scope))) {
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  }
  if (input.expiresAt != null && input.expiresAt <= now) {
    throw new ValidationError('Expiry must be in the future.', [], 'EXPIRY_PAST');
  }
  if (orgId && !(await orgIsActive(ctx.env.DB, orgId))) {
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  }
  const prefix = ctx.ids.token(6);
  const secret = `wlt_${prefix}_${ctx.ids.token(32)}`;
  const row: repo.ApiKeyRow = {
    id: ctx.ids.id(),
    org_id: orgId,
    name: input.name,
    prefix,
    key_hash: await sha256Hex(secret),
    scopes: JSON.stringify([...new Set(input.scopes)]),
    mode: authority.kind === 'session' ? authority.mode : input.mode,
    created_by: authority.userId,
    created_at: now,
    last_used_at: null,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  await repo.createKey(ctx, row, authority, {
    orgId,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: row.id,
    detail: {
      name: row.name,
      scopes: parseScopes(row.scopes),
      mode: row.mode,
      expiresAt: row.expires_at,
    },
  });
  return { ...toDto(row), secret };
}

/** Idempotent: revoking a revoked key succeeds. */
export async function revokeApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
): Promise<void> {
  if (authority.kind === 'session' && authority.capability !== 'integrations:manage') {
    throw new ForbiddenError();
  }
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

/** Resolves a presented key. Null for anything invalid; throws 429 when the key is over its limit. */
export function createApiKeyStore(env: AppEnv, clock: Clock = systemClock): ApiKeyStore {
  return {
    async resolve(rawKey): Promise<ApiKeyAuth | null> {
      const match = KEY_SHAPE.exec(rawKey);
      if (!match?.[1]) return null;
      const row = await repo.findByPrefix(env.DB, match[1]);
      if (!row || !(await safeEqual(await sha256Hex(rawKey), row.key_hash))) return null;
      const now = clock.now();
      if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now))
        return null;
      if (row.org_id !== null && row.org_status !== 'active') return null;
      await enforceRateLimit(env, 'RL_API_KEY', `key:${row.id}`);
      await repo.touchKey(env.DB, row.id, now, TOUCH_EVERY_MS);
      return {
        kind: 'api_key',
        keyId: row.id,
        orgId: row.org_id,
        scopes: parseScopes(row.scopes),
        mode: row.mode,
      };
    },
  };
}
