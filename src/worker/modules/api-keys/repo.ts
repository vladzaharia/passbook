import { grant } from '../../platform/authority.ts';
import { type Check, exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { gte, inList, orNull } from '../../platform/authority-expr.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { creatorLiveSql } from '../../platform/repo-api-key-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { ApiKeyAuthority } from './access.ts';
import type { ApiKeyRow } from './repo-row.ts';

type Db = D1Database;

export type { ApiKeyRow } from './repo-row.ts';

const NO_ORG = { org_id: null };

interface Reach {
  principal: Principal;
  checks: Check[];
  where: Record<string, SqlValue>;
}

/** How a caller reaches the key `id`: the grant's principal and lineage checks, and the row condition of its writes. */
function reach(authority: ApiKeyAuthority, id: string): Reach {
  if (authority.kind === 'platform')
    return {
      principal: {
        kind: 'platform',
        userId: authority.userId,
        sessionIdHash: authority.sessionId,
      } as const,
      checks: [exactlyOne('api_keys', { id, ...NO_ORG })],
      where: { id, ...NO_ORG },
    };
  // A key reaches only its own children.
  if (authority.kind === 'api_key') {
    const where = { id, parent_key_id: authority.keyId };
    return {
      principal: tenantPrincipal(authority),
      checks: [...capabilityChecks(authority), exactlyOne('api_keys', where)],
      where,
    };
  }
  // A member without `integrations:manage` reaches only their own personal key.
  const own = authority.capability === 'org:read';
  if (!own && authority.capability !== 'integrations:manage') throw new ForbiddenError();
  const where = own ? { id, membership_id: authority.membershipId } : { id };
  return {
    principal: tenantPrincipal(authority),
    checks: [...capabilityChecks(authority), exactlyOne('api_keys', where)],
    where,
  };
}

/**
 * Revokes a key under `org.api_key.revoke` / `platform.api_key.revoke`. Idempotent: the audit row is
 * written, in the same batch, only when this call revokes the key. A key outside the actor's org is a
 * lineage refusal. Its children are revoked with it (they would stop anyway: a child ends with its parent), and so
 * are the keys it replaced itself with.
 */
export async function revokeKey(
  ctx: ServiceContext,
  id: string,
  authority: ApiKeyAuthority,
  audit: AuditEntry,
  /** Keys this key replaced itself with, hop by hop (`selfSuccessors`): a leaked key must not outlive its revocation as its own successor. */
  successors: readonly string[] = [],
): Promise<void> {
  const { principal, checks, where } = reach(authority, id);
  const g = grant(ctx, {
    purpose: authority.kind === 'platform' ? 'platform.api_key.revoke' : 'org.api_key.revoke',
    principal,
    target: id,
    checks,
    codes: { lineage: 'API_KEY_CHANGED' },
  });
  g.add(grantedAudit(g, ctx, audit, [exists('api_keys', { id, revoked_at: null })]));
  const now = ctx.clock.now();
  if (authority.kind === 'session')
    g.update('api_keys', {
      set: { revoked_at: now },
      where: { parent_key_id: id, revoked_at: null },
    });
  if (successors.length > 0)
    g.update('api_keys', {
      set: { revoked_at: now },
      where: { id: inList(successors.slice(0, 20)), revoked_at: null },
    });
  g.update('api_keys', { set: { revoked_at: now }, where: { ...where, revoked_at: null } });
  await g.commit();
}

/**
 * A child ends with its parent: each open child retires at the same instant. One that expires sooner is left as it
 * is (it never outlives the parent), and the retirement trigger would refuse a time past its expiry.
 */
export function endChildren(g: ReturnType<typeof grant>, parentId: string, retireAt: number) {
  g.update('api_keys', {
    set: { retire_at: retireAt },
    where: {
      parent_key_id: parentId,
      retire_at: null,
      revoked_at: null,
      expires_at: orNull(gte(retireAt)),
    },
  });
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
  const { principal, checks, where } = reach(authority, id);
  const g = grant(ctx, {
    purpose: authority.kind === 'platform' ? 'platform.api_key.retire' : 'org.api_key.retire',
    principal,
    target: id,
    checks,
    codes: { lineage: 'API_KEY_CHANGED' },
  });
  const open = { retire_at: null, revoked_at: null };
  g.add(grantedAudit(g, ctx, audit, [exists('api_keys', { id, ...open })]));
  g.update('api_keys', { set: { retire_at: retireAt }, where: { ...where, ...open } });
  endChildren(g, id, retireAt);
  await g.commit();
}

export interface KeyFilter {
  orgId: string | null;
  state?: 'live' | 'revoked' | undefined;
  /** The last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
  /** A membership id: only that member's personal keys, in SQL, whatever else the caller names. */
  mine?: string | undefined;
  /** Only the children of this key. */
  parent?: string | undefined;
  /** Only keys of this mode (a Workbench token lists Test keys). */
  mode?: 'test' | undefined;
}

function keyWhere(f: Pick<KeyFilter, 'orgId' | 'state' | 'mine' | 'parent' | 'mode'>) {
  const where: string[] = [];
  const params: SqlValue[] = [f.orgId];
  where.push('k.org_id IS ?');
  if (f.state === 'live') where.push('k.revoked_at IS NULL');
  if (f.state === 'revoked') where.push('k.revoked_at IS NOT NULL');
  if (f.mine !== undefined) {
    where.push("k.kind = 'personal' AND k.membership_id = ?");
    params.push(f.mine);
  }
  if (f.parent !== undefined) {
    where.push('k.parent_key_id = ?');
    params.push(f.parent);
  }
  if (f.mode !== undefined) {
    where.push('k.mode = ?');
    params.push(f.mode);
  }
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

export async function countRevoked(
  db: Db,
  orgId: string | null,
  mine?: string,
  parent?: string,
  mode?: 'test',
): Promise<number> {
  const { where, params } = keyWhere({ orgId, state: 'revoked', mine, parent, mode });
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM api_keys k WHERE ${where.join(' AND ')}`,
    params,
  );
  return row?.n ?? 0;
}

/** Children of a key that are not revoked. */
export async function countOpenChildren(db: Db, id: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM api_keys WHERE parent_key_id = ? AND revoked_at IS NULL',
    [id],
  );
  return row?.n ?? 0;
}

export const getKey = (db: Db, id: string, orgId: string | null) =>
  first<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE id = ? AND org_id IS ?', [id, orgId]);

/**
 * The key plus its org's status (null: a platform key), for a personal key the roles of its member while that
 * membership is live and the user active (null otherwise), and for a child its parent's end times as JSON (null: none).
 */
export type ResolvedKeyRow = ApiKeyRow & {
  org_status: string | null;
  org_kind: string | null;
  member_roles: string | null;
  /** A personal key's member has a Polaris ID identity: 1, else null. */
  owner_idp: number | null;
  /** A personal key's member still keeps console access by email: `auth.consoleEmailUntil`, else null. */
  owner_grace_until: number | null;
  parent: string | null;
  /** 1 while the creator is still the admin who made the key (`creatorLiveSql`), else 0: a platform key lives only so long. */
  creator_active: number | null;
  /** A CLI token's session, as JSON (null on every other key): see `cliOf`. */
  cli: string | null;
};

/** The columns of a `ResolvedKeyRow`, over `api_keys k` and `orgs o`: also read by the try-token resolver. */
export const RESOLVED_KEY_COLUMNS = `k.*, o.status AS org_status, o.kind AS org_kind,
       (SELECT m.roles FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = k.membership_id AND m.org_id = k.org_id AND m.revoked_at IS NULL
          AND u.status = 'active') AS member_roles,
       (SELECT 1 FROM org_memberships m JOIN auth_identities i ON i.user_id = m.user_id AND i.provider = 'pocketid'
        WHERE m.id = k.membership_id LIMIT 1) AS owner_idp,
       (SELECT json_extract(st.value, '$') FROM org_memberships m
          JOIN console_email_grace g ON g.user_id = m.user_id, settings st
        WHERE m.id = k.membership_id AND st.scope = 'platform' AND st.key = 'auth.consoleEmailUntil') AS owner_grace_until,
       (SELECT json_object('revoked_at', q.revoked_at, 'expires_at', q.expires_at, 'retire_at', q.retire_at)
        FROM api_keys q WHERE q.id = k.parent_key_id) AS parent,
       (SELECT ${creatorLiveSql('k')}) AS creator_active,
       CASE WHEN k.origin = 'cli' THEN
         (SELECT json_object('revoked_at', c.token_revoked_at,
            'last_roles', (SELECT u.last_roles FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE m.id = k.membership_id),
            'sandbox_open', (SELECT 1 FROM developer_sandboxes d JOIN org_memberships m ON m.user_id = d.user_id
               WHERE d.org_id = k.org_id AND d.closed_at IS NULL AND m.id = k.membership_id))
          FROM cli_sessions c WHERE c.token_id = k.id) END AS cli`;

export const findByPrefix = (db: Db, prefix: string) =>
  first<ResolvedKeyRow>(
    db,
    `SELECT ${RESOLVED_KEY_COLUMNS}
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
    `UPDATE api_keys SET last_used_at = ?, last_ip_prefix = ?
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
