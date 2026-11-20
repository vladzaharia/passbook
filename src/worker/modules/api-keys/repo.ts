import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import type { ApiKeyKind } from '../../platform/api-key-token.ts';
import {
  ROLE_PRESETS,
  rolesCapableOf,
  scopeCapability,
  type TenantScope,
} from '../../platform/api-scopes.ts';
import { grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';
import {
  capabilityChecks,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { type ApiKeyAuthority, delegableScopes } from './access.ts';

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
  kind: ApiKeyKind;
  roles: string;
  membership_id: string | null;
  retire_at: number | null;
  restricted: number;
  ip_allow: string | null;
  rate_tier: string | null;
  secret_label: string;
}

/** What a key is written with besides its own row. */
export interface KeyExtras {
  terminalIds: readonly string[];
  templateIds: readonly string[];
  passStyles: readonly string[];
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
  extras: Partial<KeyExtras> = {},
): Promise<void> {
  const { terminalIds = [], templateIds = [], passStyles = [] } = extras;
  // The grant supplies org_id and mode of a tenant key: the creator's org and request mode.
  const columns = [
    'name',
    'prefix',
    'key_hash',
    'scopes',
    'created_by',
    'created_at',
    'expires_at',
    'kind',
    'roles',
    'membership_id',
    'restricted',
    'ip_allow',
    'secret_label',
  ];
  const values = [
    key.name,
    key.prefix,
    key.key_hash,
    key.scopes,
    key.created_by,
    key.created_at,
    key.expires_at,
    key.kind,
    key.roles,
    key.membership_id,
    key.restricted,
    key.ip_allow,
    key.secret_label,
  ];
  if (authority.kind === 'platform') {
    if (key.org_id !== null || key.kind !== 'platform' || terminalIds.length > 0)
      throw new ForbiddenError();
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
  const explicit = JSON.parse(key.scopes) as TenantScope[];
  const roles = JSON.parse(key.roles) as OrgRole[];
  const delegable: string[] = delegableScopes(authority);
  const presets = roles.flatMap((role) => ROLE_PRESETS[role]);
  const personal = key.kind === 'personal';
  // A role preset is held in full or not at all: each of its scopes must be within the creator's roles.
  const beyond =
    explicit.some((scope) => !delegable.includes(scope)) ||
    presets.some((scope) => !rolesCapableOf(scope).some((role) => authority.roles.includes(role)));
  if (
    authority.capability !== (personal ? 'org:read' : 'integrations:manage') ||
    key.org_id !== authority.orgId ||
    (personal && key.membership_id !== authority.membershipId) ||
    beyond
  )
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  if (key.mode !== authority.mode) throw new ForbiddenError();
  // The creator's own stored roles must grant each capability, not the snapshot's `roles`.
  const capabilities = new Set([...explicit, ...presets].map((scope) => scopeCapability[scope]));
  const g = grant(ctx, {
    purpose: 'org_mode.api_key.create',
    principal: tenantPrincipal(authority),
    target: key.id,
    checks: [
      ...capabilityChecks(authority),
      ...[...capabilities].map((capability) =>
        membershipCapability(authority.membershipId, capability),
      ),
      // A terminal of the grant's org and mode, still in service; the binding is written with the key.
      ...terminalIds.map((id) =>
        exactlyOne('scanners', { id, kind: 'terminal', revoked_at: null }),
      ),
      // A restricted key names templates of its own org.
      ...templateIds.map((id) => exactlyOne('templates', { id })),
    ],
    codes: {
      lineage: terminalIds.length ? 'API_KEY_TERMINAL_UNKNOWN' : 'API_KEY_TEMPLATE_UNKNOWN',
    },
  });
  g.insertSelect('api_keys', ['id', ...columns], [key.id, ...values]);
  for (const scannerId of terminalIds)
    g.insertJoined('api_key_terminals', {
      parents: { key_id: key.id, scanner_id: scannerId },
      columns: [],
      values: [],
    });
  for (const [kind, value] of [
    ...templateIds.map((id) => ['template', id] as const),
    ...passStyles.map((style) => ['pass_style', style] as const),
  ])
    g.insertJoined('api_key_resources', {
      parents: { key_id: key.id },
      columns: ['kind', 'value'],
      values: [kind, value],
    });
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
  const platform = authority.kind === 'platform';
  // A member without `integrations:manage` may end only their own personal key.
  const own = !platform && authority.capability === 'org:read';
  if (!platform && !own && authority.capability !== 'integrations:manage')
    throw new ForbiddenError();
  const g = grant(ctx, {
    purpose: platform ? 'platform.api_key.revoke' : 'org.api_key.revoke',
    principal: platform
      ? { kind: 'platform', userId: authority.userId, sessionIdHash: authority.sessionId }
      : tenantPrincipal(authority),
    target: id,
    checks: [
      ...(platform ? [] : capabilityChecks(authority)),
      exactlyOne(
        'api_keys',
        platform ? { id, ...NO_ORG } : own ? { id, membership_id: authority.membershipId } : { id },
      ),
    ],
    codes: { lineage: 'API_KEY_NOT_FOUND' },
  });
  g.add(grantedAudit(g, ctx, audit, [exists('api_keys', { id, revoked_at: null })]));
  const where = platform ? { id, ...NO_ORG, revoked_at: null } : { id, revoked_at: null };
  g.update('api_keys', { set: { revoked_at: ctx.clock.now() }, where });
  await g.commit();
}

/**
 * Ends a key at `retireAt`, once, under `org.api_key.retire` / `platform.api_key.retire`. The audit row is
 * written, in the same batch, only when this call sets it; a key already retired or revoked is not touched.
 */
export async function retireKey(
  ctx: ServiceContext,
  id: string,
  retireAt: number,
  authority: ApiKeyAuthority,
  audit: AuditEntry,
): Promise<void> {
  const platform = authority.kind === 'platform';
  if (!platform && authority.capability !== 'integrations:manage') throw new ForbiddenError();
  const g = grant(ctx, {
    purpose: platform ? 'platform.api_key.retire' : 'org.api_key.retire',
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
  const open = { retire_at: null, revoked_at: null };
  g.add(grantedAudit(g, ctx, audit, [exists('api_keys', { id, ...open })]));
  g.update('api_keys', {
    set: { retire_at: retireAt },
    where: platform ? { id, ...NO_ORG, ...open } : { id, ...open },
  });
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

/** Newest first, with the creator's name (else the email its org knows them by; a platform admin sees the account email) for the actor chip. */
export function listKeys(db: Db, f: KeyFilter, platform: boolean) {
  const { where, params } = keyWhere(f);
  if (f.cursor) {
    where.push(
      '(k.created_at, k.id) < (SELECT created_at, id FROM api_keys WHERE id = ? AND org_id IS ?)',
    );
    params.push(f.cursor, f.orgId);
  }
  return all<ApiKeyRow & { created_by_name: string | null }>(
    db,
    `SELECT k.*, CASE WHEN k.created_by IS NULL THEN NULL
       ELSE ${userLabelSql('k.created_by', 'k.org_id', platform)} END AS created_by_name
     FROM api_keys k
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

/**
 * The key plus its org's status (null: a platform key) and, for a personal key, the roles of its member
 * while that membership is live and the user active (null otherwise).
 */
export const findByPrefix = (db: Db, prefix: string) =>
  first<ApiKeyRow & { org_status: string | null; member_roles: string | null }>(
    db,
    `SELECT k.*, o.status AS org_status,
       (SELECT m.roles FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = k.membership_id AND m.org_id = k.org_id AND m.revoked_at IS NULL
          AND u.status = 'active') AS member_roles
     FROM api_keys k LEFT JOIN orgs o ON o.id = k.org_id
     WHERE k.prefix = ?`,
    [prefix],
  );

/** Writes at most once per interval. */
export async function touchKey(
  db: Db,
  id: string,
  now: number,
  everyMs: number,
  ipPrefix: string | null,
): Promise<void> {
  await run(
    db,
    `UPDATE api_keys SET last_used_at = ?, last_used_ip_prefix = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    [now, ipPrefix, id, now - everyMs],
  );
}

/** Template ids and pass styles a restricted key is limited to. */
export async function keyResources(db: Db, keyIds: readonly string[]) {
  if (keyIds.length === 0) return [];
  return all<{ key_id: string; kind: 'template' | 'pass_style'; value: string }>(
    db,
    'SELECT key_id, kind, value FROM api_key_resources WHERE key_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(keyIds)],
  );
}
