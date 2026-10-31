import type { z } from 'zod';
import type { ApiKeySchema, CreateApiKeySchema } from '../../../shared/contracts/index.ts';
import type { ApiKeyStore } from '../../platform/auth.ts';
import { API_SCOPES, type ApiKeyAuth, type ApiScope } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import { randomBytes, safeEqual, sha256Hex, toHex } from '../../platform/ids.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import * as repo from './repo.ts';

export type ApiKeyDto = z.infer<typeof ApiKeySchema>;
const KEY_SHAPE = /^wlt_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

function toDto(row: repo.ApiKeyRow): ApiKeyDto {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function parseScopes(raw: string): ApiScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is ApiScope => API_SCOPES.includes(s as ApiScope))
      : [];
  } catch {
    return [];
  }
}

export async function listApiKeys(ctx: ServiceContext): Promise<ApiKeyDto[]> {
  return (await repo.listKeys(ctx.env.DB)).map(toDto);
}

export async function createApiKey(
  ctx: ServiceContext,
  actorUserId: string,
  input: z.infer<typeof CreateApiKeySchema>,
): Promise<ApiKeyDto & { secret: string }> {
  const now = ctx.clock.now();
  const orgId = input.orgId ?? null;
  if (input.expiresAt != null && input.expiresAt <= now) {
    throw new ValidationError('Expiry must be in the future.', [], 'EXPIRY_PAST');
  }
  if (orgId && !(await repo.orgExists(ctx.env.DB, orgId))) {
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  }
  const prefix = toHex(randomBytes(4));
  const secret = `wlt_${prefix}_${ctx.ids.token(32)}`;
  const row: repo.ApiKeyRow = {
    id: ctx.ids.id(),
    org_id: orgId,
    name: input.name,
    prefix,
    key_hash: await sha256Hex(secret),
    scopes: JSON.stringify([...new Set(input.scopes)]),
    created_by: actorUserId,
    created_at: now,
    last_used_at: null,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  await repo.insertKey(ctx.env.DB, row);
  await recordAudit(ctx, {
    orgId,
    actorType: 'user',
    actorId: actorUserId,
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: row.id,
    detail: { name: row.name, scopes: parseScopes(row.scopes), expiresAt: row.expires_at },
  });
  return { ...toDto(row), secret };
}

/** Idempotent: revoking a revoked key succeeds. */
export async function revokeApiKey(
  ctx: ServiceContext,
  actorUserId: string,
  id: string,
): Promise<void> {
  const key = await repo.getKey(ctx.env.DB, id);
  if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  if (await repo.revokeKey(ctx.env.DB, id, ctx.clock.now())) {
    await recordAudit(ctx, {
      orgId: key.org_id,
      actorType: 'user',
      actorId: actorUserId,
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: id,
    });
  }
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
      return { kind: 'api_key', keyId: row.id, orgId: row.org_id, scopes: parseScopes(row.scopes) };
    },
  };
}
