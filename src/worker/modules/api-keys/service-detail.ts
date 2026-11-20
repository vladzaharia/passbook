import type { z } from 'zod';
import type { ApiKeyActivitySchema, ApiKeyDetailSchema } from '../../../shared/contracts/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ApiKeyAuthority, authorityOrgId } from './access.ts';
import { keyResources } from './repo.ts';
import { callSummary, getKeyDetail, recentCalls } from './repo-family.ts';
import { reachable } from './service.ts';
import { type Resources, toDto } from './service-dto.ts';

const DAY = 86_400_000;
const SUMMARY_DAYS = 30;

export async function resourcesOf(ctx: ServiceContext, keyId: string): Promise<Resources> {
  const rows = await keyResources(ctx.env.DB, [keyId]);
  return {
    templateIds: rows.filter((r) => r.kind === 'template').map((r) => r.value),
    passStyles: rows
      .filter((r) => r.kind === 'pass_style')
      .map((r) => r.value) as Resources['passStyles'],
  };
}

const named = (json: string | null) =>
  json ? (JSON.parse(json) as { id: string; name: string }) : null;

/** One key with its place in the family and its last use; never the secret or its hash. */
export async function getApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  platformEmails: boolean,
): Promise<z.infer<typeof ApiKeyDetailSchema>> {
  const row = await getKeyDetail(ctx.env.DB, id, authorityOrgId(authority), platformEmails);
  if (!row || (authority.kind === 'api_key' && row.parent_key_id !== authority.keyId))
    throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  return {
    ...toDto(row, await resourcesOf(ctx, id), authority.kind !== 'api_key'),
    lastIpPrefix: row.last_ip_prefix,
    parent: named(row.parent),
    replacedBy: named(row.replaced_by),
    childCount: row.child_count,
  };
}

/** Last use, what the key did over the last 30 days by action, and its latest calls: from the audit log, no bodies. */
export async function getApiKeyActivity(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  limit: number,
): Promise<z.infer<typeof ApiKeyActivitySchema>> {
  const key = await reachable(ctx, authority, id);
  const since = ctx.clock.now() - SUMMARY_DAYS * DAY;
  const [recent, actions] = await Promise.all([
    recentCalls(ctx.env.DB, id, limit),
    callSummary(ctx.env.DB, id, since),
  ]);
  return {
    lastUsedAt: key.last_used_at,
    lastIpPrefix: key.last_ip_prefix,
    summary: {
      since,
      calls: actions.reduce((sum, a) => sum + a.n, 0),
      denied: actions.find((a) => a.action === 'auth.denied')?.n ?? 0,
      actions: actions.map((a) => ({ action: a.action, count: a.n, lastAt: a.last_at })),
    },
    recent: recent.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      outcome: r.action === 'auth.denied' ? 'denied' : 'allowed',
      targetType: r.target_type,
      targetId: r.target_id,
      ipPrefix: r.ip_prefix,
      code: r.code,
    })),
  };
}
