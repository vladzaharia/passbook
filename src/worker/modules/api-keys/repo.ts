import type { Mode } from '../../../shared/contracts/common.ts';
import type { ApiScope } from '../../platform/auth.ts';
import { grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import {
  capabilityChecks,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { type ApiKeyAuthority, delegableScopes, scopeCapability } from './access.ts';

type Db = D1Database;

export interface ApiKeyRow {
  id: string;
  org_id: string | null;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  mode: Mode;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

const PLATFORM_KEY_TENANT = ['org_id', 'mode'];
const NO_ORG = { org_id: null };

/**
 * Mints a key under a grant: `org_mode.api_key.create` for an org-bound key (the creator's live membership
 * and session, `integrations:manage`, in the request's mode) or `platform.api_key.create` for a null-org key (a live admin
 * session). A key cannot hold scopes beyond its creator's roles: `delegableScopes` is derived from the
 * membership's roles, which are immutable, and re-checked here so the repo stands alone.
 */
export async function createKey(
  ctx: ServiceContext,
  key: ApiKeyRow,
  authority: ApiKeyAuthority,
  audit: AuditEntry,
): Promise<void> {
  // The grant supplies org_id and mode of a tenant key: the creator's org and request mode.
  const columns = [
    'name',
    'prefix',
    'key_hash',
    'scopes',
    'created_by',
    'created_at',
    'expires_at',
  ];
  const values = [
    key.name,
    key.prefix,
    key.key_hash,
    key.scopes,
    key.created_by,
    key.created_at,
    key.expires_at,
  ];
  if (authority.kind === 'platform') {
    if (key.org_id !== null) throw new ForbiddenError();
    const g = grant(ctx, {
      purpose: 'platform.api_key.create',
      principal: { kind: 'platform', userId: authority.userId, sessionIdHash: authority.sessionId },
      target: key.id,
    });
    // A platform grant injects no tenant: a platform key names its own (null) org and mode.
    const platformColumns = ['id', ...PLATFORM_KEY_TENANT, ...columns];
    const platformValues = [key.id, null, key.mode, ...values];
    g.insertSelect('api_keys', platformColumns, platformValues);
    g.add(grantedAudit(g, ctx, audit));
    await g.commit();
    return;
  }
  const delegable: string[] = delegableScopes(authority);
  const wanted = JSON.parse(key.scopes) as string[];
  if (
    authority.capability !== 'integrations:manage' ||
    key.org_id !== authority.orgId ||
    wanted.some((scope) => !delegable.includes(scope))
  )
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  if (key.mode !== authority.mode) throw new ForbiddenError();
  const g = grant(ctx, {
    purpose: 'org_mode.api_key.create',
    principal: tenantPrincipal(authority),
    target: key.id,
    // Each scope must be granted by the creator's own stored roles, not by the snapshot's `roles`.
    checks: [
      ...capabilityChecks(authority),
      ...wanted.map((scope) =>
        membershipCapability(authority.membershipId, scopeCapability[scope as ApiScope]),
      ),
    ],
  });
  g.insertSelect('api_keys', ['id', ...columns], [key.id, ...values]);
  g.add(grantedAudit(g, ctx, audit));
  await g.commit();
}

/**
 * Revokes a key under `org.api_key.revoke` / `platform.api_key.revoke`. Idempotent: the audit row is
 * written, in the same batch, only when this call revokes the key. A key outside the actor's org is a
 * lineage refusal.
 */
export async function revokeKey(
  ctx: ServiceContext,
  id: string,
  authority: ApiKeyAuthority,
  audit: AuditEntry,
): Promise<void> {
  if (authority.kind !== 'platform' && authority.capability !== 'integrations:manage')
    throw new ForbiddenError();
  const platform = authority.kind === 'platform';
  const g = grant(ctx, {
    purpose: platform ? 'platform.api_key.revoke' : 'org.api_key.revoke',
    principal: platform
      ? { kind: 'platform', userId: authority.userId, sessionIdHash: authority.sessionId }
      : tenantPrincipal(authority),
    target: id,
    checks: [
      ...(platform ? [] : capabilityChecks(authority)),
      exactlyOne('api_keys', platform ? { id, ...NO_ORG } : { id }),
    ],
    codes: { lineage: 'API_KEY_NOT_FOUND' },
  });
  g.add(grantedAudit(g, ctx, audit, [exists('api_keys', { id, revoked_at: null })]));
  const where = platform ? { id, ...NO_ORG, revoked_at: null } : { id, revoked_at: null };
  g.update('api_keys', { set: { revoked_at: ctx.clock.now() }, where });
  await g.commit();
}

export interface KeyFilter {
  orgId: string | null;
  state?: 'live' | 'revoked' | undefined;
  /** The last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

function keyWhere(f: Pick<KeyFilter, 'orgId' | 'state'>) {
  const where: string[] = [];
  const params: SqlValue[] = [f.orgId];
  where.push('k.org_id IS ?');
  if (f.state === 'live') where.push('k.revoked_at IS NULL');
  if (f.state === 'revoked') where.push('k.revoked_at IS NOT NULL');
  return { where, params };
}

/** Newest first, with the creator's name (or email) for the actor chip. */
export function listKeys(db: Db, f: KeyFilter) {
  const { where, params } = keyWhere(f);
  if (f.cursor) {
    where.push(
      '(k.created_at, k.id) < (SELECT created_at, id FROM api_keys WHERE id = ? AND org_id IS ?)',
    );
    params.push(f.cursor, f.orgId);
  }
  return all<ApiKeyRow & { created_by_name: string | null }>(
    db,
    `SELECT k.*, coalesce(u.name, u.primary_email) AS created_by_name
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY k.created_at DESC, k.id DESC LIMIT ?`,
    [...params, f.limit],
  );
}

export async function countRevoked(db: Db, orgId: string | null): Promise<number> {
  const { where, params } = keyWhere({ orgId, state: 'revoked' });
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM api_keys k WHERE ${where.join(' AND ')}`,
    params,
  );
  return row?.n ?? 0;
}

export const getKey = (db: Db, id: string, orgId: string | null) =>
  first<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE id = ? AND org_id IS ?', [id, orgId]);

/** The key plus its org's status; null org status means a platform key. */
export const findByPrefix = (db: Db, prefix: string) =>
  first<ApiKeyRow & { org_status: string | null }>(
    db,
    `SELECT k.*, o.status AS org_status FROM api_keys k LEFT JOIN orgs o ON o.id = k.org_id
     WHERE k.prefix = ?`,
    [prefix],
  );

/** Writes at most once per interval. */
export async function touchKey(db: Db, id: string, now: number, everyMs: number): Promise<void> {
  await run(
    db,
    'UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
    [now, id, now - everyMs],
  );
}
